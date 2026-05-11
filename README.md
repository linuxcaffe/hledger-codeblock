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

Each block renders with a **↻ refresh button** that re-runs the query live without reloading the page.

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

2. **`flask_route.py`** — a single Flask route (`/api/hledger-query`).  
   Receives the query string, runs `hledger <args> --output-format json`, and returns structured JSON. Write commands are blocked. Only read-only report commands are permitted.

No database. No intermediate format. Just hledger's own JSON output, rendered client-side.

---

## Installation

### Requirements

- [hledger](https://hledger.org/install.html) on `$PATH`
- `LEDGER_FILE` environment variable set (or pass `-f yourfile.journal` in each query)
- Python 3 + [Flask](https://flask.palletsprojects.com/) for the backend
- [marked.js](https://marked.js.org/) v4+ for markdown rendering

### 1. Backend (Flask)

Copy `flask_route.py` into your project and register the blueprint:

```python
from flask_route import hledger_bp
app.register_blueprint(hledger_bp)
```

Or just copy the `hledger_query()` function directly into your existing `app.py`.

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

## Demo

```bash
git clone https://github.com/linuxcaffe/hledger-codeblock
cd hledger-codeblock/demo
LEDGER_FILE=~/finances/main.journal python app.py
# open http://localhost:5050
```

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

The backend endpoint is **read-only by design**:

- Only a fixed allowlist of hledger report commands is permitted (`balance`, `register`, `incomestatement`, `balancesheet`, `cashflow`, `accounts`, `prices`, `commodities`, `stats`, `tags`, `files`)
- The endpoint calls `hledger` via `subprocess.run` with `shell=False` — no shell injection is possible
- Path traversal via `--file` flags is blocked

This is intended for **personal, local, or trusted-network use** — the same threat model as hledger-web.

---

## Origin

Built as part of [nb-web](https://github.com/linuxcaffe/nb-web), a web UI for the [nb](https://github.com/xwmx/nb) notes CLI. Extracted here as a standalone component because it felt too useful to keep to itself.

The pattern was inspired by [obsidian-tw-task-wiki](https://github.com/SntTGR/obsidian-tw-task-wiki), which does the same thing for Taskwarrior inside Obsidian. To our knowledge, this is the first live hledger query renderer for a markdown notes environment.

---

## Contributing

Issues and PRs welcome. The hledger JSON output format is well-documented at [hledger.org](https://hledger.org/dev/hledger.html#output-format) — additional report types (e.g. `print`, `aregister`) or richer rendering (sparklines, multi-period columns) would be natural extensions.

## License

MIT
