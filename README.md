# hledger-codeblock

Live [hledger](https://hledger.org) report rendering inside fenced markdown code blocks.

Write a query in a fenced block tagged `hledger` and get an interactive, styled table — in your notes app, wiki, or any web UI that renders markdown.

````markdown
```hledger
balance assets expenses --depth 2
```

```hledger
register checking --period thismonth
```

```hledger
incomestatement --period thisyear
```
````

Each block renders with a header bar containing:

- **+** — open an inline add-transaction form (no hledger-web required)
- **⎋** — open in hledger-web, pre-filtered to the block's account pattern *(optional, see below)*
- **↻** — re-run the query live without reloading the page

---

## Supported report types

| Command | Aliases | Renders as |
|---------|---------|-----------|
| `balance` | `bal`, `b` | Account tree with depth indentation, totals row |
| `register` | `reg`, `r` | Transaction ledger with running balance; continuation postings dimmed |
| `incomestatement` | `is` | Sectioned table (Revenues / Expenses) |
| `balancesheet` | `bs` | Sectioned table (Assets / Liabilities / Equity) |
| `cashflow` | `cf` | Sectioned table |
| anything else | | Plain-text `<pre>` fallback |

All hledger filter flags work as normal — `--depth`, `--period`, `--begin`, `--end`, account patterns, tag filters, etc.

```
balance expenses --depth 3 --period 'last month'
register checking --begin 2026-01-01 tag:rent
balancesheet --end 2025-12-31
```

---

## How it works

Two small pieces:

1. **`hledger-codeblock.js`** — a [marked.js](https://marked.js.org/) renderer extension.  
   Intercepts ` ```hledger ``` ` blocks during markdown parsing, replaces them with placeholder `<div>` elements, then fetches live data from the backend and renders the appropriate table type.

2. **`flask_route.py`** — two Flask routes.  
   `/api/hledger-query` runs read-only hledger reports and returns structured JSON.  
   `/api/hledger-add` appends a new transaction, validates it with `hledger check`, and rolls back on error.

No database. No intermediate format. Just hledger's own JSON output, rendered client-side.

---

## Installation

### Requirements

- [hledger](https://hledger.org/install.html) on `$PATH`
- Python 3 + [Flask](https://flask.palletsprojects.com/) for the backend
- [marked.js](https://marked.js.org/) v4+ for markdown rendering

`LEDGER_FILE` in the environment is optional. If unset, hledger falls back to `~/.hledger.journal` — its own default behaviour.

### 1. Backend (Flask)

Copy `flask_route.py` into your project and register the blueprint:

```python
from flask_route import hledger_bp
app.register_blueprint(hledger_bp)
```

Or copy the route functions directly into your existing `app.py`.

### 2. Frontend

Add to your HTML:

```html
<link rel="stylesheet" href="hledger-codeblock.css">
<script src="marked.min.js"></script>
<script src="hledger-codeblock.js"></script>
```

Install the renderer and call `renderAll` after inserting markdown output into the DOM:

```js
// Install once, before parsing any markdown
HledgerCodeblock.install(marked);

// After inserting rendered HTML into the DOM:
const html = marked.parse(markdownSource);
contentDiv.innerHTML = html;
HledgerCodeblock.renderAll(contentDiv);
```

All options and their defaults:

```js
HledgerCodeblock.install(marked, {
    apiEndpoint:   '/api/hledger-query',  // read endpoint
    addEndpoint:   '/api/hledger-add',    // write endpoint
    hledgerWebUrl: null,                  // enables ⎋ button when set
});
```

### 3. Write queries in your notes

In any markdown note:

````markdown
My finances as of today:

```hledger
balance assets liabilities --depth 2
```

Recent transactions:

```hledger
register --period thisweek
```
````

---

## Adding transactions

Every block has a **+** button that opens an inline add form — no hledger-web required.

The form has date, description, and two posting rows. **The second amount auto-fills with the negative of the first** as you type, since double-entry transactions must balance. You can override it, leave it blank (hledger infers the balancing amount), or add more posting rows with **+ posting**.

On save, the transaction is appended to the ledger file and validated with `hledger check`. If validation fails, the append is rolled back and the error is shown inline.

---

## Targeting a specific ledger file

Prefix the query with a file path and both the block and its add form will use that file instead of `LEDGER_FILE` or the default:

````markdown
```hledger
~/finances/personal.journal
register expenses --period thismonth
```
````

The path (anything starting with `~` or `/`) is extracted before the rest of the query is parsed. All file paths are validated to stay within your home directory.

---

## Optional: hledger-web integration

If you run [hledger-web](https://hledger.org/hledger-web.html) alongside your notes app, pass its base URL when installing. Each block gains a **⎋** button that opens hledger-web pre-filtered to the account pattern from the current query.

```js
HledgerCodeblock.install(marked, {
    hledgerWebUrl: 'http://localhost:5002',
});
```

hledger-web defaults to port 5000. If that conflicts with another service, start it on a different port:

```bash
hledger-web --port=5002
```

---

## Demo

```bash
git clone https://github.com/linuxcaffe/hledger-codeblock
cd hledger-codeblock/demo
python app.py
# open http://localhost:5050
```

Set `LEDGER_FILE` or pass a path in the demo's example blocks. If neither is set, hledger looks for `~/.hledger.journal`.

---

## Theming

`hledger-codeblock.css` is built on CSS custom properties. Override any variable in your own stylesheet:

```css
:root {
    --hlc-pos:       #27ae60;   /* positive amounts */
    --hlc-neg:       #e74c3c;   /* negative amounts */
    --hlc-bg-alt:    #f5f5f5;   /* table header / totals background */
    --hlc-font-mono: 'Fira Code', monospace;
}
```

Dark mode is supported out of the box — add `data-theme="dark"` to your `<html>` element:

```css
[data-theme="dark"] {
    --hlc-pos: #57ab5a;
    --hlc-neg: #e5534b;
    /* ... */
}
```

---

## Security

Both endpoints are designed for **personal, local, or trusted-network use** — the same threat model as hledger-web itself.

- Only an explicit allowlist of hledger report commands is permitted on the query endpoint
- Both endpoints call `hledger` via `subprocess.run` with `shell=False` — no shell injection is possible
- All file paths (positional shorthand and `-f`/`--file` flags) are resolved and validated to stay within the user's home directory
- The write endpoint appends to an existing file only; it never creates files or accepts absolute paths outside `~`

---

## Origin

Built as part of [nb-web](https://codeberg.org/linuxcaffe/nb-web), a web UI for the [nb](https://github.com/xwmx/nb) notes CLI. Extracted here as a standalone component because it felt too useful to keep to itself.

The pattern was inspired by [obsidian-tw-task-wiki](https://github.com/SntTGR/obsidian-tw-task-wiki), which does the same thing for Taskwarrior inside Obsidian. To our knowledge, this is the first live hledger query renderer for a markdown notes environment.

---

## Contributing

Issues and PRs welcome. The hledger JSON output format is well-documented at [hledger.org](https://hledger.org/dev/hledger.html#output-format) — additional report types (e.g. `print`, `aregister`) or richer rendering (sparklines, multi-period columns) would be natural extensions.

## License

MIT
