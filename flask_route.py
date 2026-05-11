"""
flask_route.py — hledger-codeblock backend for Flask

Drop this into any Flask app and register the blueprint:

    from flask_route import hledger_bp
    app.register_blueprint(hledger_bp)

Or copy the single route function into your existing Flask app.

Requires: hledger installed and on $PATH, LEDGER_FILE set in the environment
(or passed via the -f flag in the query string).

https://github.com/linuxcaffe/hledger-codeblock
"""

import json
import os
import re
import subprocess

from flask import Blueprint, jsonify, request

hledger_bp = Blueprint('hledger', __name__)

# Commands allowed through the read-only endpoint.
_READ_CMDS = {
    'balance', 'bal', 'b',
    'register', 'reg', 'r',
    'incomestatement', 'is',
    'balancesheet', 'bs',
    'cashflow', 'cf',
    'accounts', 'acc', 'a',
    'prices', 'commodities', 'stats', 'tags', 'files',
}


@hledger_bp.route('/api/hledger-query')
def hledger_query():
    """
    Run a read-only hledger report and return structured JSON.

    Query parameters:
        q   hledger command + filter args, e.g. "balance assets --depth 2"

    Response (success):
        { "cmd": "balance", "data": <hledger JSON output> }
        { "cmd": "accounts", "text": "plain text output" }  (commands that don't emit JSON)

    Response (error):
        { "error": "message" }
    """
    q    = request.args.get('q', '').strip()
    args = q.split() if q else ['balance']
    cmd  = args[0].lower()

    if cmd not in _READ_CMDS:
        return jsonify({'error': f'Command not allowed: {args[0]}'}), 400

    # Reject any flags that could write data or load unsafe files.
    # (belt-and-suspenders — read commands don't write, but be explicit)
    for arg in args[1:]:
        if re.match(r'^--(file|rules-file)=?', arg) and '..' in arg:
            return jsonify({'error': 'Path traversal not allowed'}), 400

    try:
        result = subprocess.run(
            ['hledger'] + args + ['--output-format', 'json'],
            capture_output=True,
            text=True,
            env={**os.environ, 'NO_COLOR': '1', 'TERM': 'dumb'},
            timeout=15,
        )

        if result.returncode != 0:
            err = result.stderr.strip() or 'hledger exited with an error'
            return jsonify({'error': err}), 500

        try:
            data = json.loads(result.stdout or 'null')
            return jsonify({'cmd': cmd, 'data': data})
        except json.JSONDecodeError:
            # Command doesn't support JSON output — return plain text
            return jsonify({'cmd': cmd, 'text': result.stdout.strip()})

    except FileNotFoundError:
        return jsonify({'error': 'hledger not found — is it installed and on $PATH?'}), 500
    except subprocess.TimeoutExpired:
        return jsonify({'error': 'hledger timed out (15 s limit)'}), 500
