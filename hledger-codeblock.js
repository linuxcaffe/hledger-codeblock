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
 * File path shorthand: prefix the query with a ledger file path and the
 * block (including the add form) will use that file instead of LEDGER_FILE:
 *
 *   ```hledger
 *   ~/finances/alt.journal
 *   register thismonth
 *   ```
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
                : `${sign}${abs}${sym ? ' ' + sym : ''}`;
        }).join(' + ');
    }

    // Return CSS class based on sign of total amount.
    function amtCls(amounts) {
        const total = (amounts || []).reduce((s, a) => s + (a.aquantity?.floatingPoint ?? 0), 0);
        return total < -0.001 ? 'hlc-neg' : total > 0.001 ? 'hlc-pos' : 'hlc-zero';
    }

    // Negate a user-typed amount string: "$10" → "-$10", "-$10" → "$10".
    function negateAmount(s) {
        s = (s || '').trim();
        return s.startsWith('-') ? s.slice(1).trim() : s ? '-' + s : '';
    }

    // ── Add form ───────────────────────────────────────────────────────────

    function showAddForm(el, trigger) {
        const existing = el.querySelector('.hlc-addform');
        if (existing) {
            existing.remove();
            trigger.classList.remove('hlc-btn-active');
            return;
        }
        trigger.classList.add('hlc-btn-active');

        const today = new Date().toLocaleDateString('en-CA');  // YYYY-MM-DD

        function makePostingRow() {
            const row = document.createElement('div');
            row.className = 'hlc-posting-row';
            row.innerHTML = `
                <input type="text" class="hlc-inp hlc-acc-inp" placeholder="account:name" autocomplete="off" spellcheck="false">
                <input type="text" class="hlc-inp hlc-amt-inp" placeholder="amount (blank to auto-balance)">
                <button class="hlc-btn hlc-rm-row" title="Remove posting">✕</button>`;
            row.querySelector('.hlc-rm-row').addEventListener('click', () => {
                if (form.querySelectorAll('.hlc-posting-row').length > 2) row.remove();
            });
            return row;
        }

        const form = document.createElement('div');
        form.className = 'hlc-addform';
        form.innerHTML = `
            <div class="hlc-addform-top">
                <input type="date" class="hlc-inp hlc-date-inp" value="${today}">
                <input type="text" class="hlc-inp hlc-desc-inp" placeholder="Description" autocomplete="off">
            </div>
            <div class="hlc-postings"></div>
            <div class="hlc-addform-footer">
                <button class="hlc-btn hlc-add-row">+ posting</button>
                <button class="hlc-btn hlc-btn-primary hlc-save-btn">Save</button>
                <button class="hlc-btn hlc-cancel-btn">Cancel</button>
                <span class="hlc-form-status"></span>
            </div>`;

        const postingsEl = form.querySelector('.hlc-postings');
        const row1 = makePostingRow();
        const row2 = makePostingRow();
        postingsEl.appendChild(row1);
        postingsEl.appendChild(row2);

        // Auto-balance: row2 mirrors the negative of row1 until the user edits it.
        const amt1 = row1.querySelector('.hlc-amt-inp');
        const amt2 = row2.querySelector('.hlc-amt-inp');
        amt1.addEventListener('input', () => {
            if (!amt2._userEdited) amt2.value = negateAmount(amt1.value);
        });
        amt2.addEventListener('input', () => {
            amt2._userEdited = amt2.value !== '' && amt2.value !== negateAmount(amt1.value);
        });

        form.querySelector('.hlc-add-row').addEventListener('click', () =>
            postingsEl.appendChild(makePostingRow()));

        function dismiss() {
            form.remove();
            trigger.classList.remove('hlc-btn-active');
        }

        form.querySelector('.hlc-cancel-btn').addEventListener('click', dismiss);
        form.addEventListener('keydown', e => { if (e.key === 'Escape') dismiss(); });

        form.querySelector('.hlc-save-btn').addEventListener('click', async () => {
            const status   = form.querySelector('.hlc-form-status');
            const date     = form.querySelector('.hlc-date-inp').value;
            const desc     = form.querySelector('.hlc-desc-inp').value.trim();
            const postings = [...form.querySelectorAll('.hlc-posting-row')].map(r => ({
                account: r.querySelector('.hlc-acc-inp').value.trim(),
                amount:  r.querySelector('.hlc-amt-inp').value.trim(),
            })).filter(p => p.account);

            if (!date || !desc) { status.textContent = 'Date and description required'; return; }
            if (!postings.length) { status.textContent = 'At least one posting required'; return; }

            status.textContent = 'Saving…';
            status.style.color = '';
            try {
                const hlFile = el.dataset.hlFile || '';
                const r = await fetch(HledgerCodeblock.addEndpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        date, description: desc, postings,
                        ...(hlFile && { file: hlFile }),
                    }),
                });
                const d = await r.json();
                if (d.error) {
                    status.textContent = '✗ ' + d.error;
                    status.style.color = 'var(--hlc-neg)';
                } else {
                    dismiss();
                    await HledgerCodeblock._reload(el);
                }
            } catch (e) {
                status.textContent = '✗ ' + e.message;
                status.style.color = 'var(--hlc-neg)';
            }
        });

        el.querySelector('.hlc-header').insertAdjacentElement('afterend', form);
        form.querySelector('.hlc-desc-inp')?.focus();
    }

    // ── Header bar ─────────────────────────────────────────────────────────

    function buildHeader(el, q, refresh) {
        const hdr = document.createElement('div');
        hdr.className = 'hlc-header';
        hdr.innerHTML = `<span class="hlc-meta">${q ? `<code>${esc(q)}</code>` : 'hledger'}</span>`;

        const acts = document.createElement('span');
        acts.className = 'hlc-actions';

        // + always shows — opens inline add form
        const addBtn = document.createElement('button');
        addBtn.className = 'hlc-btn hlc-add-btn';
        addBtn.title = 'Add transaction';
        addBtn.textContent = '+';
        addBtn.addEventListener('click', () => showAddForm(el, addBtn));
        acts.appendChild(addBtn);

        // ⎋ only when hledger-web URL is configured
        if (HledgerCodeblock.hledgerWebUrl) {
            const webBtn = document.createElement('button');
            webBtn.className = 'hlc-btn hlc-web-btn';
            webBtn.title = 'Open in hledger-web';
            webBtn.textContent = '⎋';
            webBtn.addEventListener('click', () => {
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
        apiEndpoint:   '/api/hledger-query',
        addEndpoint:   '/api/hledger-add',
        hledgerWebUrl: null,   // e.g. 'http://localhost:5002' — enables ⎋ button

        /**
         * Register the "hledger" fenced-block renderer with marked.js.
         * Call once before parsing any markdown.
         *
         * @param {object} markedInstance  The `marked` global or import.
         * @param {object} [options]
         * @param {string} [options.apiEndpoint]   URL of the backend query endpoint.
         * @param {string} [options.addEndpoint]   URL of the backend write endpoint.
         * @param {string} [options.hledgerWebUrl] Base URL of hledger-web, e.g.
         *                                         'http://localhost:5002'. When set,
         *                                         each block gains a ⎋ (open in
         *                                         hledger-web) button.
         */
        install(markedInstance, options = {}) {
            if (options.apiEndpoint)   this.apiEndpoint   = options.apiEndpoint;
            if (options.addEndpoint)   this.addEndpoint   = options.addEndpoint;
            if (options.hledgerWebUrl) this.hledgerWebUrl = options.hledgerWebUrl;
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
                // Store resolved file path so the add form targets the same file.
                el.dataset.hlFile = d.file || '';
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
