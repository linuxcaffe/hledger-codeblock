"""
flask_route.py — hledger-codeblock backend for Flask

Drop this into any Flask app and register the blueprint:

    from flask_route import hledger_bp
    app.register_blueprint(hledger_bp)

Or copy the route functions into your existing Flask app.

Requires: hledger installed and on $PATH.
LEDGER_FILE in the environment is optional — if unset, hledger falls back
to ~/.hledger.journal (its own default). The write endpoint also accepts
a 'file' field in the POST body (set automatically when a positional path
is given in the codeblock query).

https://github.com/linuxcaffe/hledger-codeblock
"""

import json
import os
from pathlib import Path
import subprocess

from flask import Blueprint, jsonify, request

hledger_bp = Blueprint('hledger', __name__)

# Commands allowed through the read-only query endpoint.
_READ_CMDS = {
    'balance', 'bal', 'b',
    'register', 'reg', 'r',
    'incomestatement', 'is',
    'balancesheet', 'bs',
    'cashflow', 'cf',
    'accounts', 'acc', 'a',
    'prices', 'commodities', 'stats', 'tags', 'files',
}


def _resolve_file(path_str):
    """Resolve and validate a ledger file path; must stay within home dir."""
    resolved = Path(os.path.expanduser(path_str)).resolve()
    if not resolved.is_relative_to(Path.home()):
        raise ValueError('File path must be within home directory')
    return resolved


@hledger_bp.route('/api/hledger-query')
def hledger_query():
    """
    Run a read-only hledger report and return structured JSON.

    Query parameters:
        q   hledger command + filter args, e.g. "balance assets --depth 2"
            Optionally prefix with a ledger file path:
            "~/finances/alt.journal register thismonth"

    Response (success):
        { "cmd": "balance", "data": <hledger JSON output> }
        { "cmd": "accounts", "text": "plain text output" }
        Optional: "file": "/abs/path/to/ledger" when a positional path was given.

    Response (error):
        { "error": "message" }
    """
    q    = request.args.get('q', '').strip()
    args = q.split() if q else ['balance']

    # Positional file path: first token starting with ~ or / is the ledger file.
    file_path = None
    if args and (args[0].startswith('~') or args[0].startswith('/')):
        try:
            file_path = _resolve_file(args[0])
        except ValueError as e:
            return jsonify({'error': str(e)}), 403
        args = args[1:] or ['balance']

    cmd = args[0].lower()
    if cmd not in _READ_CMDS:
        return jsonify({'error': f'Command not allowed: {args[0]}'}), 400

    # Expand ~ in explicit -f / --file args.
    expanded = [args[0]]
    i = 1
    while i < len(args):
        a = args[i]
        if a in ('-f', '--file') and i + 1 < len(args):
            try:
                resolved = _resolve_file(args[i + 1])
            except ValueError as e:
                return jsonify({'error': str(e)}), 403
            expanded += [a, str(resolved)]
            i += 2
        elif a.startswith('--file='):
            try:
                resolved = _resolve_file(a[7:])
            except ValueError as e:
                return jsonify({'error': str(e)}), 403
            expanded.append(f'--file={resolved}')
            i += 1
        else:
            expanded.append(a)
            i += 1

    # Inject positional file path as -f (after command, before other args).
    if file_path:
        expanded = [expanded[0], '-f', str(file_path)] + expanded[1:]

    try:
        result = subprocess.run(
            ['hledger'] + expanded + ['--output-format', 'json'],
            capture_output=True,
            text=True,
            env={**os.environ, 'NO_COLOR': '1', 'TERM': 'dumb'},
            timeout=15,
        )

        if result.returncode != 0:
            err = result.stderr.strip() or 'hledger exited with an error'
            return jsonify({'error': err}), 500

        extra = {'file': str(file_path)} if file_path else {}
        try:
            data = json.loads(result.stdout or 'null')
            return jsonify({'cmd': cmd, 'data': data, **extra})
        except json.JSONDecodeError:
            return jsonify({'cmd': cmd, 'text': result.stdout.strip(), **extra})

    except FileNotFoundError:
        return jsonify({'error': 'hledger not found — is it installed and on $PATH?'}), 500
    except subprocess.TimeoutExpired:
        return jsonify({'error': 'hledger timed out (15 s limit)'}), 500


@hledger_bp.route('/api/hledger-add', methods=['POST'])
def hledger_add():
    """
    Append a new transaction to the ledger file; validates with hledger check
    and rolls back on error.

    POST body (JSON):
        date        YYYY-MM-DD
        description string
        postings    [{account, amount}, ...]  amount may be blank (auto-balance)
        file        optional absolute path — takes priority over LEDGER_FILE env
    """
    data     = request.get_json(silent=True) or {}
    date     = data.get('date', '').strip()
    desc     = data.get('description', '').strip()
    postings = [p for p in data.get('postings', [])
                if str(p.get('account', '')).strip()]

    if not date or not desc:
        return jsonify({'error': 'Date and description are required'}), 400
    if not postings:
        return jsonify({'error': 'At least one posting is required'}), 400

    # File resolution priority: codeblock path > LEDGER_FILE env > hledger default.
    file_param = data.get('file', '').strip()
    if file_param:
        try:
            ledger_path = _resolve_file(file_param)
        except ValueError as e:
            return jsonify({'error': str(e)}), 403
    else:
        ledger_env = os.environ.get('LEDGER_FILE', '')
        ledger_path = Path(os.path.expanduser(ledger_env)) if ledger_env \
                      else Path.home() / '.hledger.journal'

    if not ledger_path.exists():
        return jsonify({'error': f'Ledger file not found: {ledger_path}'}), 400

    lines = [f'{date} {desc}']
    for p in postings:
        account = str(p.get('account', '')).strip()
        amount  = str(p.get('amount',  '')).strip()
        lines.append(f'    {account}    {amount}' if amount else f'    {account}')
    entry = '\n'.join(lines) + '\n'

    original_size = ledger_path.stat().st_size
    try:
        with open(ledger_path, 'a') as f:
            f.write('\n' + entry)

        result = subprocess.run(
            ['hledger', '-f', str(ledger_path), 'check'],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode != 0:
            with open(ledger_path, 'r+') as f:
                f.truncate(original_size)
            return jsonify({'error': result.stderr.strip() or 'Validation failed'}), 400

        return jsonify({'ok': True})
    except Exception as e:
        try:
            with open(ledger_path, 'r+') as f:
                f.truncate(original_size)
        except Exception:
            pass
        return jsonify({'error': str(e)}), 500
