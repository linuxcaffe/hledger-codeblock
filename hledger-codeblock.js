/**
 * hledger-codeblock.js
 *
 * Live hledger report renderer for marked.js.
 * Fenced code blocks with language "hledger" are replaced with
 * interactive, styled tables fetched from a small backend endpoint.
 *
 * Usage:
 *   HledgerCodeblock.install(marked, { apiEndpoint: '/api/hledger-query' });
 *   // after inserting rendered HTML into the DOM:
 *   HledgerCodeblock.renderAll(containerElement);
 *
 * Supported report types:
 *   balance / bal / b          → account tree, totals row
 *   register / reg / r         → transaction ledger, running balance
 *   incomestatement / is       → sectioned (Revenues / Expenses)
 *   balancesheet / bs          → sectioned (Assets / Liabilities / Equity)
 *   cashflow / cf              → sectioned
 *   anything else              → plain-text <pre> fallback
 *
 * https://github.com/linuxcaffe/hledger-codeblock
 */

(function (global) {
    'use strict';

    // ── Helpers ────────────────────────────────────────────────────────────

    function esc(s) {
        const d = document.createElement('div');
        d.textContent = String(s ?? '');
        return d.innerHTML;
    }

    // Format an hledger JSON amount array → human-readable string.
    // Respects commodity symbol side, decimal precision, and digit grouping.
    function fmtAmts(amounts) {
        if (!amounts?.length) return '0';
        return amounts.map(a => {
            const qty  = a.aquantity?.floatingPoint ?? 0;
            const sym  = a.acommodity || '';
            const prec = a.astyle?.asprecision ?? 2;
            const abs  = Math.abs(qty).toFixed(prec).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
            const sign = qty < 0 ? '−' : '';   // proper minus sign
            return a.astyle?.ascommodityside === 'L'
                ? `${sign}${sym}${abs}`
                : `${sign}${abs}${sym ? ' ' + sym : ''}`;
        }).join(' + ');
    }

    // Return CSS class based on sign of total amount.
    function amtCls(amounts) {
        const total = (amounts || []).reduce((s, a) => s + (a.aquantity?.floatingPoint ?? 0), 0);
        return total < -0.001 ? 'hlc-neg' : total > 0.001 ? 'hlc-pos' : 'hlc-zero';
    }

    // Build the header bar (query label + refresh button).
    function buildHeader(el, q, refresh) {
        const hdr = document.createElement('div');
        hdr.className = 'hlc-header';
        hdr.innerHTML = `<span class="hlc-meta">${q ? `<code>${esc(q)}</code>` : 'hledger'}</span>`;

        const acts = document.createElement('span');
        acts.className = 'hlc-actions';

        // ＋ open hledger-web add form
        if (HledgerCodeblock.hledgerWebUrl) {
            const addBtn = document.createElement('button');
            addBtn.className = 'hlc-btn hlc-add-btn';
            addBtn.title = 'Add transaction in hledger-web';
            addBtn.textContent = '+';
            addBtn.addEventListener('click', () =>
                window.open(`${HledgerCodeblock.hledgerWebUrl}/add`, 'hledger-web'));
            acts.appendChild(addBtn);
        }

        // ⎋ open hledger-web pre-filtered to this query's account pattern
        if (HledgerCodeblock.hledgerWebUrl) {
            const webBtn = document.createElement('button');
            webBtn.className = 'hlc-btn hlc-web-btn';
            webBtn.title = 'Open in hledger-web';
            webBtn.textContent = '⎋';
            webBtn.addEventListener('click', () => {
                // Extract a bare account pattern from the query (first non-flag word after the verb)
                const args    = (q || '').split(/\s+/);
                const pattern = args.slice(1).find(a => !a.startsWith('-')) || '';
                const hash    = pattern ? `#${encodeURIComponent(pattern)}` : '';
                window.open(`${HledgerCodeblock.hledgerWebUrl}${hash}`, 'hledger-web');
            });
            acts.appendChild(webBtn);
        }

        // ↻ refresh
        const refBtn = document.createElement('button');
        refBtn.className = 'hlc-btn hlc-refresh';
        refBtn.title = 'Refresh';
        refBtn.textContent = '↻';
        refBtn.addEventListener('click', refresh);
        acts.appendChild(refBtn);

        hdr.appendChild(acts);
        el.appendChild(hdr);
    }

    // ── Report renderers ───────────────────────────────────────────────────

    // balance / bal / b
    // data = [rows_array, totals_array]
    // rows_array  : [[displayName, fullName, depth, [amounts]], ...]
    // totals_array: [{acommodity, aquantity, ...}, ...]
    function renderBalance(el, data, q) {
        const rows   = Array.isArray(data?.[0]) ? data[0] : [];
        const totals = Array.isArray(data?.[1]) ? data[1] : [];
        buildHeader(el, q, () => HledgerCodeblock._reload(el));

        if (!rows.length) {
            el.insertAdjacentHTML('beforeend', '<div class="hlc-empty">No accounts matched</div>');
            return;
        }

        const tbody = rows.map(([name, , depth, amounts]) => {
            const cls = amtCls(amounts);
            return `<tr>
                <td class="hlc-account" style="padding-left:${8 + depth * 16}px">${esc(name)}</td>
                <td class="hlc-amt ${cls}">${fmtAmts(amounts)}</td>
            </tr>`;
        }).join('');

        const totCls = amtCls(totals);
        el.insertAdjacentHTML('beforeend', `
            <table class="hlc-table">
                <thead><tr><th>Account</th><th class="hlc-amt">Balance</th></tr></thead>
                <tbody>${tbody}</tbody>
                <tfoot><tr class="hlc-total-row">
                    <td>Total</td>
                    <td class="hlc-amt ${totCls}">${fmtAmts(totals)}</td>
                </tr></tfoot>
            </table>`);
    }

    // register / reg / r
    // data: [[date|null, date2|null, desc|null, posting, [runningBalance]], ...]
    // Rows with null date are continuation postings of the same transaction.
    function renderRegister(el, data, q) {
        const rows = Array.isArray(data) ? data : [];
        buildHeader(el, q, () => HledgerCodeblock._reload(el));

        if (!rows.length) {
            el.insertAdjacentHTML('beforeend', '<div class="hlc-empty">No transactions matched</div>');
            return;
        }

        const tbody = rows.map(([date, , desc, posting, balance]) => {
            const account = posting?.paccount || '';
            const amounts = posting?.pamount  || [];
            const isCont  = date == null;
            return `<tr class="${isCont ? 'hlc-cont' : ''}">
                <td class="hlc-date">${isCont ? '' : esc(date || '')}</td>
                <td class="hlc-desc">${isCont ? '' : esc(desc || '')}</td>
                <td class="hlc-account">${esc(account)}</td>
                <td class="hlc-amt ${amtCls(amounts)}">${fmtAmts(amounts)}</td>
                <td class="hlc-amt ${amtCls(balance)}">${fmtAmts(balance)}</td>
            </tr>`;
        }).join('');

        el.insertAdjacentHTML('beforeend', `
            <table class="hlc-table">
                <thead><tr>
                    <th>Date</th><th>Description</th><th>Account</th>
                    <th class="hlc-amt">Amount</th><th class="hlc-amt">Balance</th>
                </tr></thead>
                <tbody>${tbody}</tbody>
            </table>`);
    }

    // incomestatement / balancesheet / cashflow
    // data: { cbrSubreports: [[sectionName, {prRows, prTotals}, negate], ...] }
    function renderSectioned(el, data, q) {
        const subreports = data?.cbrSubreports || [];
        buildHeader(el, q, () => HledgerCodeblock._reload(el));

        for (const [sectionName, report] of subreports) {
            const rows   = report?.prRows   || [];
            const totals = report?.prTotals;

            el.insertAdjacentHTML('beforeend',
                `<div class="hlc-section">${esc(sectionName)}</div>`);

            if (!rows.length) {
                el.insertAdjacentHTML('beforeend',
                    '<div class="hlc-empty hlc-section-empty">—</div>');
                continue;
            }

            const tbody = rows.map(r => {
                const name    = (r.prrName    || [])[0] || '';
                const amounts = (r.prrAmounts || [[]])[0] || [];
                return `<tr>
                    <td class="hlc-account">${esc(name)}</td>
                    <td class="hlc-amt ${amtCls(amounts)}">${fmtAmts(amounts)}</td>
                </tr>`;
            }).join('');

            const sectionTotal = (totals?.prrAmounts || [[]])[0] || [];
            el.insertAdjacentHTML('beforeend', `
                <table class="hlc-table hlc-section-table">
                    <tbody>${tbody}</tbody>
                    <tfoot><tr class="hlc-total-row">
                        <td>Total ${esc(sectionName)}</td>
                        <td class="hlc-amt ${amtCls(sectionTotal)}">${fmtAmts(sectionTotal)}</td>
                    </tr></tfoot>
                </table>`);
        }
    }

    // Plain-text fallback (commands that don't emit JSON)
    function renderPre(el, text, q) {
        buildHeader(el, q, () => HledgerCodeblock._reload(el));
        el.insertAdjacentHTML('beforeend', `<pre class="hlc-pre">${esc(text)}</pre>`);
    }

    // ── Report-type dispatch ───────────────────────────────────────────────

    const BALANCE   = new Set(['balance', 'bal', 'b']);
    const REGISTER  = new Set(['register', 'reg', 'r']);
    const SECTIONED = new Set(['incomestatement', 'is', 'balancesheet', 'bs', 'cashflow', 'cf']);

    // ── Public API ─────────────────────────────────────────────────────────

    const HledgerCodeblock = {
        apiEndpoint:    '/api/hledger-query',
        hledgerWebUrl:  null,   // e.g. 'http://localhost:5002' — enables ＋ and ⎋ buttons

        /**
         * Register the "hledger" fenced-block renderer with marked.js.
         * Call once before parsing any markdown.
         *
         * @param {object} markedInstance  The `marked` global or import.
         * @param {object} [options]
         * @param {string} [options.apiEndpoint]   URL of the backend query endpoint.
         * @param {string} [options.hledgerWebUrl] Base URL of hledger-web, e.g.
         *                                         'http://localhost:5002'. When set,
         *                                         each block gains a ＋ (add transaction)
         *                                         and ⎋ (open in hledger-web) button.
         */
        install(markedInstance, options = {}) {
            if (options.apiEndpoint)   this.apiEndpoint   = options.apiEndpoint;
            if (options.hledgerWebUrl) this.hledgerWebUrl = options.hledgerWebUrl;
            const self = this;
            markedInstance.use({
                renderer: {
                    code({ text, lang }) {
                        if (lang !== 'hledger') return false;
                        const q = text.trim().replace(/"/g, '&quot;');
                        return `<div class="hlc-block" data-query="${q}"><span class="hlc-spin">⟳</span></div>`;
                    }
                }
            });
        },

        /**
         * Find every .hlc-block in container and render it.
         * Call after inserting marked output into the DOM.
         *
         * @param {Element} container
         */
        async renderAll(container) {
            for (const el of container.querySelectorAll('.hlc-block'))
                await this._reload(el);
        },

        // Internal: (re)fetch and render a single block element.
        async _reload(el) {
            const q = el.dataset.query || '';
            el.innerHTML = '<span class="hlc-spin">⟳</span>';
            try {
                const r = await fetch(`${this.apiEndpoint}?q=${encodeURIComponent(q)}`);
                const d = await r.json();
                if (d.error) {
                    el.innerHTML = `<span class="hlc-error">⚠ ${esc(d.error)}</span>`;
                    return;
                }
                el.innerHTML = '';
                if (d.text != null) { renderPre(el, d.text, q); return; }
                const cmd = (d.cmd || 'balance').toLowerCase();
                if (BALANCE.has(cmd))        renderBalance(el, d.data, q);
                else if (REGISTER.has(cmd))  renderRegister(el, d.data, q);
                else if (SECTIONED.has(cmd)) renderSectioned(el, d.data, q);
                else renderPre(el, JSON.stringify(d.data, null, 2), q);
            } catch (e) {
                el.innerHTML = `<span class="hlc-error">⚠ ${esc(e.message)}</span>`;
            }
        },
    };

    global.HledgerCodeblock = HledgerCodeblock;
}(window));
