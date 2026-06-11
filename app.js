'use strict';
/* Barbershop — offline-first cash/card tracker for barbers.
   Zero dependencies. All money is stored as integer cents. */

/* ---------------------------------------------------------------- helpers */
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const fmt$ = (cents) => USD.format((cents || 0) / 100);
const fmtWhole$ = (cents) => '$' + Math.round((cents || 0) / 100).toLocaleString('en-US');

// "35", "35.5", "35.50", "$1,200" -> cents (int) or null
function parse$(str) {
  const s = String(str ?? '').replace(/[$,\s]/g, '');
  if (s === '') return null;
  if (!/^\d{0,7}(\.\d{0,2})?$/.test(s)) return null;
  return Math.round(parseFloat(s || '0') * 100);
}

const uid = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10));

const DAY = 86400000;
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
const dayKey = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const fmtTime = (ts) => new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const fmtDayLong = (ts) => new Date(ts).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const other = (m) => (m === 'cash' ? 'card' : 'cash');
const vibrate = (ms) => { try { navigator.vibrate && navigator.vibrate(ms); } catch (e) { /* no-op */ } };

/* ----------------------------------------------------------- IndexedDB */
const DB_NAME = 'barbershop', DB_VER = 1;
let _db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('jobs')) db.createObjectStore('jobs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('expenses')) db.createObjectStore('expenses', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function tx(store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = _db.transaction(store, mode);
    const s = t.objectStore(store);
    const out = fn(s);
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
const dbPut = (store, val) => tx(store, 'readwrite', (s) => s.put(val));
const dbDel = (store, key) => tx(store, 'readwrite', (s) => s.delete(key));
const dbClear = (store) => tx(store, 'readwrite', (s) => s.clear());
const dbAll = (store) => new Promise((resolve, reject) => {
  const t = _db.transaction(store, 'readonly');
  const req = t.objectStore(store).getAll();
  req.onsuccess = () => resolve(req.result || []);
  req.onerror = () => reject(req.error);
});
const kvSet = (key, val) => tx('kv', 'readwrite', (s) => s.put(val, key));
const kvGet = (key) => new Promise((resolve, reject) => {
  const t = _db.transaction('kv', 'readonly');
  const req = t.objectStore('kv').get(key);
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

/* ----------------------------------------------------------------- state */
const DEFAULT_SERVICES = [
  { id: uid(), name: 'Haircut', price: 3500 },
  { id: uid(), name: 'Beard trim', price: 2000 },
  { id: uid(), name: 'Lineup', price: 1500 },
  { id: uid(), name: 'Cut + beard', price: 5000 },
];
const DEFAULT_CATEGORIES = ['Booth rent', 'Supplies', 'Equipment', 'Other'];

let settings = {
  name: '', services: [], categories: [...DEFAULT_CATEGORIES],
  onboarded: false, lastBackup: 0, nudgeDismissed: 0, installDismissed: false,
};
let jobs = [];      // in-memory mirror, kept sorted by ts asc
let expenses = [];  // in-memory mirror

const now = () => Date.now();

const ui = {
  tab: 'log',
  dashPeriod: 'today',
  historyY: new Date().getFullYear(),
  historyM: new Date().getMonth(),
  log: freshLogState(),
  payLock: false,
};
function freshLogState() {
  return { sel: new Set(), custom: [], tip: 0, tipIsCustom: false, tipFlip: false, note: '', noteOpen: false };
}

async function saveSettings() {
  await kvSet('settings', settings);
  try { localStorage.setItem('bb-settings', JSON.stringify(settings)); } catch (e) { /* private mode */ }
}

async function loadState() {
  _db = await openDB();
  const stored = await kvGet('settings');
  if (stored) settings = Object.assign(settings, stored);
  if (!settings.services.length && !settings.onboarded) settings.services = DEFAULT_SERVICES.map((s) => ({ ...s }));
  jobs = (await dbAll('jobs')).sort((a, b) => a.ts - b.ts);
  expenses = (await dbAll('expenses')).sort((a, b) => a.ts - b.ts);
}

/* ------------------------------------------------------------ mutations */
function requestPersist() {
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) { /* best effort */ }
}

let persistAsked = false;
async function addJob(job) {
  jobs.push(job); jobs.sort((a, b) => a.ts - b.ts);
  await dbPut('jobs', job);
  if (!persistAsked) { persistAsked = true; requestPersist(); }
}
async function updateJob(job) {
  const i = jobs.findIndex((j) => j.id === job.id);
  if (i >= 0) jobs[i] = job;
  await dbPut('jobs', job);
}
async function deleteJob(id) { jobs = jobs.filter((j) => j.id !== id); await dbDel('jobs', id); }
async function addExpense(x) { expenses.push(x); expenses.sort((a, b) => a.ts - b.ts); await dbPut('expenses', x); }
async function updateExpense(x) {
  const i = expenses.findIndex((e) => e.id === x.id);
  if (i >= 0) expenses[i] = x;
  expenses.sort((a, b) => a.ts - b.ts);
  await dbPut('expenses', x);
}
async function deleteExpense(id) { expenses = expenses.filter((e) => e.id !== id); await dbDel('expenses', id); }

/* ------------------------------------------------------------ stats */
// Money-in for a job, split by where the money physically arrives.
function jobCash(j) { return (j.method === 'cash' ? j.amount : 0) + (j.tipMethod === 'cash' ? j.tip : 0); }
function jobCard(j) { return (j.method === 'card' ? j.amount : 0) + (j.tipMethod === 'card' ? j.tip : 0); }

function collect(from, to) { // [from, to)
  const out = { cash: 0, card: 0, tips: 0, revenue: 0, count: 0, tipped: 0, expenses: 0 };
  for (const j of jobs) {
    if (j.ts < from || j.ts >= to) continue;
    out.cash += jobCash(j); out.card += jobCard(j);
    out.tips += j.tip; out.revenue += j.amount; out.count++;
    if (j.tip > 0) out.tipped++;
  }
  for (const x of expenses) {
    if (x.ts < from || x.ts >= to) continue;
    out.expenses += x.amount;
  }
  out.total = out.cash + out.card;
  out.net = out.total - out.expenses;
  return out;
}

function periodWindow(period) {
  const n = new Date();
  if (period === 'today') {
    const from = startOfDay(n);
    return { from, to: from + DAY, prevFrom: from - DAY, prevTo: from, vs: 'vs yesterday' };
  }
  const endToday = startOfDay(n) + DAY; // include all of today, even future-stamped entries
  if (period === 'month') {
    const from = new Date(n.getFullYear(), n.getMonth(), 1).getTime();
    const prevFrom = new Date(n.getFullYear(), n.getMonth() - 1, 1).getTime();
    return { from, to: endToday, prevFrom, prevTo: prevFrom + (now() - from) + 1, vs: 'vs last month' };
  }
  const from = new Date(n.getFullYear(), 0, 1).getTime();
  const prevFrom = new Date(n.getFullYear() - 1, 0, 1).getTime();
  return { from, to: endToday, prevFrom, prevTo: prevFrom + (now() - from) + 1, vs: 'vs last year' };
}

/* --------------------------------------------------------- toast system */
let toastTimer = null;
function showToast(html, opts = {}) {
  const root = $('#toast-root');
  clearTimeout(toastTimer);
  root.innerHTML = `<div class="toast">${html}</div>`;
  toastTimer = setTimeout(() => { root.innerHTML = ''; }, opts.ms || 4500);
}
function hideToast() { clearTimeout(toastTimer); $('#toast-root').innerHTML = ''; }

/* --------------------------------------------------------- sheet system */
function openSheet(html, opts = {}) {
  const root = $('#sheet-root');
  root.innerHTML = `
    <div class="backdrop" data-a="${opts.locked ? 'noop' : 'sheet-close'}"></div>
    <div class="sheet" role="dialog" aria-modal="true">
      <div class="sheet-grab"></div>
      ${html}
    </div>`;
  document.body.classList.add('no-scroll');
  requestAnimationFrame(() => root.classList.add('open'));
}
function closeSheet() {
  const root = $('#sheet-root');
  root.classList.remove('open');
  root.innerHTML = '';
  document.body.classList.remove('no-scroll');
}

/* ============================================================ LOG screen */
function logTotals() {
  let amount = 0;
  for (const id of ui.log.sel) {
    const s = settings.services.find((x) => x.id === id);
    if (s) amount += s.price;
  }
  for (const c of ui.log.custom) amount += c;
  return { amount, tip: ui.log.tip, total: amount + ui.log.tip };
}

function renderLog() {
  const t = collect(startOfDay(now()), startOfDay(now()) + DAY);
  const lt = logTotals();
  const hasSel = lt.amount > 0;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const showInstall = settings.onboarded && !standalone && !settings.installDismissed;

  const svcTiles = settings.services.map((s) => `
    <button class="svc ${ui.log.sel.has(s.id) ? 'sel' : ''}" data-a="svc" data-id="${s.id}">
      <span class="svc-name">${esc(s.name)}</span>
      <span class="svc-price">${fmt$(s.price)}</span>
      ${ui.log.sel.has(s.id) ? '<span class="svc-check">✓</span>' : ''}
    </button>`).join('');

  const customTiles = ui.log.custom.map((c, i) => `
    <button class="svc sel" data-a="custom-remove" data-i="${i}">
      <span class="svc-name">Custom</span>
      <span class="svc-price">${fmt$(c)}</span>
      <span class="svc-check">✕</span>
    </button>`).join('');

  const tipChips = [
    { v: 0, label: 'No tip' }, { v: 500, label: '$5' }, { v: 1000, label: '$10' },
  ].map((c) => `<button class="chip ${ui.log.tip === c.v && !ui.log.tipIsCustom ? 'on' : ''}"
      data-a="tip" data-v="${c.v}">${c.label}</button>`).join('') +
    `<button class="chip ${ui.log.tipIsCustom ? 'on' : ''}" data-a="tip-custom">
      ${ui.log.tipIsCustom ? esc(fmt$(ui.log.tip)) + ' ✎' : 'Custom'}</button>`;

  $('#screen-log').innerHTML = `
    ${showInstall ? `
      <div class="banner" data-a="install-open">
        <span class="banner-emoji">📲</span>
        <span class="banner-text"><strong>Add to your home screen</strong><br>Opens like an app, works offline</span>
        <button class="banner-x" data-a="install-dismiss" aria-label="Dismiss">✕</button>
      </div>` : ''}

    <button class="card today-strip" data-a="goto-dash">
      <div>
        <p class="label">Today so far</p>
        <p class="big num">${fmt$(t.total)}</p>
        <p class="sub">Cash ${fmt$(t.cash)} · Card ${fmt$(t.card)} · ${t.count} cut${t.count === 1 ? '' : 's'}</p>
      </div>
      <span class="strip-arrow">›</span>
    </button>

    <p class="section-label">Services ${settings.services.length === 0 ? '' : '<span class="hint">tap to select — combos welcome</span>'}</p>
    <div class="svc-grid">
      ${svcTiles}${customTiles}
      <button class="svc svc-custom" data-a="custom-add">
        <span class="svc-name">Custom</span>
        <span class="svc-price">amount…</span>
      </button>
    </div>
    ${settings.services.length === 0 ? `<div class="empty-mini">No services yet — <button class="linkbtn" data-a="services-open">set up your menu</button></div>` : ''}

    <p class="section-label">Tip</p>
    <div class="chip-row">${tipChips}</div>
    ${ui.log.tip > 0 ? `
      <button class="chip chip-ghost ${ui.log.tipFlip ? 'on' : ''}" data-a="tip-flip">
        ⇄ tip paid in the <strong>other</strong> method ${ui.log.tipFlip ? '· on' : ''}
      </button>` : ''}

    <div class="note-row">
      ${ui.log.noteOpen
        ? `<input id="job-note" class="note-input" type="text" maxlength="80" placeholder="Client name or note…" value="${esc(ui.log.note)}">`
        : `<button class="linkbtn" data-a="note-open">＋ add note</button>`}
    </div>

    <div class="pay-row">
      <button class="pay pay-cash" data-a="pay" data-v="cash" ${hasSel && !ui.payLock ? '' : 'disabled'}>
        <span class="pay-label">💵 Cash</span>
        <span class="pay-amt num">${hasSel ? fmt$(lt.total) : '—'}</span>
      </button>
      <button class="pay pay-card" data-a="pay" data-v="card" ${hasSel && !ui.payLock ? '' : 'disabled'}>
        <span class="pay-label">💳 Card</span>
        <span class="pay-amt num">${hasSel ? fmt$(lt.total) : '—'}</span>
      </button>
    </div>`;

  if (ui.log.noteOpen) {
    const input = $('#job-note');
    input.addEventListener('input', () => { ui.log.note = input.value; });
  }
}

async function payJob(method) {
  const lt = logTotals();
  if (lt.amount <= 0 || ui.payLock) return;
  ui.payLock = true;
  setTimeout(() => { ui.payLock = false; renderLog(); }, 700);

  const services = [];
  for (const id of ui.log.sel) {
    const s = settings.services.find((x) => x.id === id);
    if (s) services.push({ name: s.name, price: s.price });
  }
  for (const c of ui.log.custom) services.push({ name: 'Custom', price: c });

  const job = {
    id: uid(), ts: now(), services, amount: lt.amount,
    method, tip: ui.log.tip, tipMethod: ui.log.tip > 0 ? (ui.log.tipFlip ? other(method) : method) : method,
    note: ui.log.note.trim(),
  };
  await addJob(job);
  ui.log = freshLogState();
  vibrate(15);
  renderLog();
  const desc = services.map((s) => s.name).join(' + ');
  showToast(`
    <span class="toast-text">Saved · ${esc(desc)} ${fmt$(job.amount)}${job.tip ? ` + ${fmt$(job.tip)} tip` : ''} · ${job.method}</span>
    <button class="toast-btn" data-a="undo" data-id="${job.id}">Undo</button>`, { ms: 6000 });
}

/* ======================================================= DASHBOARD screen */
function trendChip(cur, prev, vs) {
  if (prev <= 0) return '';
  const pct = Math.round(((cur - prev) / prev) * 100);
  const up = pct >= 0;
  return `<span class="trend ${up ? 'up' : 'down'}">${up ? '↑' : '↓'} ${Math.abs(pct)}% <em>${vs}</em></span>`;
}

function chartData(period) {
  const n = new Date();
  if (period === 'today') {
    const bars = [];
    for (let i = 13; i >= 0; i--) {
      const from = startOfDay(now()) - i * DAY;
      const c = collect(from, from + DAY);
      const d = new Date(from);
      bars.push({ v: c.total, label: i % 2 === 0 ? String(d.getDate()) : '' });
    }
    return { bars, caption: 'Last 14 days' };
  }
  if (period === 'month') {
    const bars = [];
    for (let i = 11; i >= 0; i--) {
      const from = new Date(n.getFullYear(), n.getMonth() - i, 1).getTime();
      const to = new Date(n.getFullYear(), n.getMonth() - i + 1, 1).getTime();
      const c = collect(from, to);
      bars.push({ v: c.total, label: MONTHS[new Date(from).getMonth()][0] });
    }
    return { bars, caption: 'Last 12 months' };
  }
  const firstYear = jobs.length ? new Date(jobs[0].ts).getFullYear() : n.getFullYear();
  const span = Math.min(6, Math.max(2, n.getFullYear() - firstYear + 1));
  const bars = [];
  for (let i = span - 1; i >= 0; i--) {
    const y = n.getFullYear() - i;
    const c = collect(new Date(y, 0, 1).getTime(), new Date(y + 1, 0, 1).getTime());
    bars.push({ v: c.total, label: `'${String(y).slice(2)}` });
  }
  return { bars, caption: 'By year' };
}

function chartSVG(data) {
  const W = 336, H = 150, padB = 22, padT = 30;
  const n = data.bars.length;
  const gap = 6;
  const bw = Math.floor((W - gap * (n - 1)) / n);
  const max = Math.max(...data.bars.map((b) => b.v), 1);
  let bars = '', labels = '', callout = '';
  data.bars.forEach((b, i) => {
    const h = b.v === 0 ? 3 : Math.max(6, Math.round((b.v / max) * (H - padB - padT)));
    const x = i * (bw + gap);
    const y = H - padB - h;
    const cur = i === n - 1;
    bars += `<rect x="${x}" y="${y}" width="${bw}" height="${h}" rx="${Math.min(6, bw / 2)}"
      fill="${cur ? 'var(--lime)' : '#E7E7E2'}"/>`;
    if (b.label) labels += `<text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle" class="ch-label">${esc(b.label)}</text>`;
    if (cur && b.v > 0) {
      const tx = Math.min(Math.max(x + bw / 2, 30), W - 30);
      callout = `<g><rect x="${tx - 30}" y="${Math.max(0, y - 26)}" width="60" height="20" rx="10" fill="var(--lime)"/>
        <text x="${tx}" y="${Math.max(0, y - 26) + 14}" text-anchor="middle" class="ch-callout">${esc(fmtWhole$(b.v))}</text></g>`;
    }
  });
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Revenue chart">${bars}${labels}${callout}</svg>`;
}

function renderDash() {
  const p = ui.dashPeriod;
  const w = periodWindow(p);
  const c = collect(w.from, w.to);
  const prev = collect(w.prevFrom, w.prevTo);
  const ch = chartData(p);
  const pctCash = c.total ? Math.round((c.cash / c.total) * 100) : 0;
  const pctCard = c.total ? 100 - pctCash : 0;
  const avgTicket = c.count ? Math.round(c.revenue / c.count) : 0;
  const avgTip = c.tipped ? Math.round(c.tips / c.tipped) : 0;
  const periodName = { today: 'Today', month: 'This month', year: 'This year' }[p];
  const showNudge = jobs.length >= 20 &&
    now() - (settings.lastBackup || 0) > 30 * DAY &&
    now() - (settings.nudgeDismissed || 0) > 7 * DAY;

  $('#screen-dash').innerHTML = `
    <div class="seg" role="tablist">
      ${['today', 'month', 'year'].map((k) => `
        <button class="seg-btn ${p === k ? 'on' : ''}" data-a="period" data-v="${k}" role="tab">
          ${{ today: 'Today', month: 'Month', year: 'Year' }[k]}</button>`).join('')}
    </div>

    ${showNudge ? `
      <div class="banner banner-warn" data-a="goto-more">
        <span class="banner-emoji">🛟</span>
        <span class="banner-text"><strong>Back up your data</strong><br>It only lives on this phone</span>
        <button class="banner-x" data-a="nudge-dismiss" aria-label="Dismiss">✕</button>
      </div>` : ''}

    <div class="card hero">
      <p class="label">${periodName} · total revenue</p>
      <p class="huge num">${fmt$(c.total)}</p>
      ${trendChip(c.total, prev.total, w.vs)}
    </div>

    <div class="grid2">
      <div class="card tint-peach">
        <p class="label"><span class="dot dot-cash"></span>Cash</p>
        <p class="big num">${fmt$(c.cash)}</p>
        <p class="sub">${pctCash}% of total</p>
      </div>
      <div class="card tint-lav">
        <p class="label"><span class="dot dot-card"></span>Card</p>
        <p class="big num">${fmt$(c.card)}</p>
        <p class="sub">${pctCard}% of total</p>
      </div>
    </div>

    <div class="grid2">
      <div class="card tint-mint">
        <p class="label">Tips</p>
        <p class="big num">${fmt$(c.tips)}</p>
        <p class="sub">${c.tipped} tipped cut${c.tipped === 1 ? '' : 's'}</p>
      </div>
      <div class="card">
        <p class="label">Expenses <button class="mini-add" data-a="expense-open">＋ Add</button></p>
        <p class="big num ${c.expenses ? 'expense-num' : ''}">${c.expenses ? '−' + fmt$(c.expenses) : fmt$(0)}</p>
        <p class="sub">Net profit <strong class="num">${fmt$(c.net)}</strong></p>
      </div>
    </div>

    <div class="card">
      <p class="label">${esc(ch.caption)}</p>
      ${c.total === 0 && ch.bars.every((b) => b.v === 0)
        ? `<div class="empty-mini">No revenue yet — log your first cut and watch this fill up ✂️</div>`
        : chartSVG(ch)}
    </div>

    <div class="card stats3">
      <div><p class="label">Cuts</p><p class="mid num">${c.count}</p></div>
      <div><p class="label">Avg ticket</p><p class="mid num">${fmt$(avgTicket)}</p></div>
      <div><p class="label">Avg tip</p><p class="mid num">${fmt$(avgTip)}</p></div>
    </div>

    ${p === 'today' ? `
      <button class="card eod-btn" data-a="eod-open">
        <span>🌙 End the day</span><span class="strip-arrow">›</span>
      </button>` : ''}`;
}

/* ========================================================= HISTORY screen */
function renderHistory() {
  const y = ui.historyY, m = ui.historyM;
  const from = new Date(y, m, 1).getTime();
  const to = new Date(y, m + 1, 1).getTime();
  const n = new Date();
  const isCurrent = y === n.getFullYear() && m === n.getMonth();

  const items = [
    ...jobs.filter((j) => j.ts >= from && j.ts < to).map((j) => ({ kind: 'job', ts: j.ts, it: j })),
    ...expenses.filter((x) => x.ts >= from && x.ts < to).map((x) => ({ kind: 'exp', ts: x.ts, it: x })),
  ].sort((a, b) => b.ts - a.ts);

  const groups = new Map();
  for (const item of items) {
    const k = dayKey(item.ts);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(item);
  }

  const todayK = dayKey(now()), yestK = dayKey(now() - DAY);
  let body = '';
  for (const [k, list] of groups) {
    const dayIn = list.filter((i) => i.kind === 'job').reduce((s, i) => s + jobCash(i.it) + jobCard(i.it), 0);
    const dayOut = list.filter((i) => i.kind === 'exp').reduce((s, i) => s + i.it.amount, 0);
    const title = k === todayK ? 'Today' : k === yestK ? 'Yesterday' : fmtDayLong(list[0].ts);
    body += `<div class="day-head"><span>${esc(title)}</span>
      <span class="num">${dayIn ? '+' + fmt$(dayIn) : ''}${dayIn && dayOut ? ' · ' : ''}${dayOut ? '−' + fmt$(dayOut) : ''}</span></div>`;
    body += list.map((i) => i.kind === 'job' ? `
      <button class="row" data-a="edit-job" data-id="${i.it.id}">
        <span class="dot ${i.it.method === 'cash' ? 'dot-cash' : 'dot-card'}"></span>
        <span class="row-main">
          <span class="row-title">${esc(i.it.services.map((s) => s.name).join(' + ') || 'Job')}</span>
          <span class="row-sub">${fmtTime(i.it.ts)} · ${i.it.method}${i.it.note ? ' · ' + esc(i.it.note) : ''}</span>
        </span>
        <span class="row-amt num">${fmt$(i.it.amount)}${i.it.tip ? `<em>+${fmt$(i.it.tip)} tip</em>` : ''}</span>
      </button>` : `
      <button class="row" data-a="edit-exp" data-id="${i.it.id}">
        <span class="dot dot-exp"></span>
        <span class="row-main">
          <span class="row-title">${esc(i.it.category)}</span>
          <span class="row-sub">expense${i.it.note ? ' · ' + esc(i.it.note) : ''}</span>
        </span>
        <span class="row-amt num row-neg">−${fmt$(i.it.amount)}</span>
      </button>`).join('');
  }

  $('#screen-history').innerHTML = `
    <div class="month-nav">
      <button class="month-btn" data-a="month" data-v="-1" aria-label="Previous month">‹</button>
      <span class="month-title">${MONTHS[m]} ${y}</span>
      <button class="month-btn" data-a="month" data-v="1" ${isCurrent ? 'disabled' : ''} aria-label="Next month">›</button>
    </div>
    ${body || `<div class="empty card"><p>Nothing in ${MONTHS[m]} ${y}.</p><p class="sub">Cuts and expenses you log show up here — tap any entry to fix it.</p></div>`}`;
}

/* ============================================================ MORE screen */
function renderMore() {
  const lastBk = settings.lastBackup
    ? new Date(settings.lastBackup).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : 'never';
  $('#screen-more').innerHTML = `
    <div class="card">
      <p class="label">Your name</p>
      <input id="name-input" class="text-input" type="text" maxlength="30" placeholder="What should we call you?" value="${esc(settings.name)}">
    </div>

    <p class="section-label">Shop setup</p>
    <div class="card list-card">
      <button class="mrow" data-a="services-open"><span>✂️ Services &amp; prices</span><span class="mrow-end">${settings.services.length} ›</span></button>
      <button class="mrow" data-a="categories-open"><span>🏷️ Expense categories</span><span class="mrow-end">${settings.categories.length} ›</span></button>
    </div>

    <p class="section-label">Your data</p>
    <div class="card list-card">
      <button class="mrow" data-a="export-csv"><span>📄 Export CSV</span><span class="mrow-end">for taxes ›</span></button>
      <button class="mrow" data-a="backup"><span>🛟 Back up data</span><span class="mrow-end">last: ${esc(lastBk)} ›</span></button>
      <button class="mrow" data-a="restore-pick"><span>📥 Restore a backup</span><span class="mrow-end">›</span></button>
    </div>
    <p class="finehint">Everything is stored only on this phone — back up regularly so a lost phone never means lost records.</p>

    <p class="section-label">App</p>
    <div class="card list-card">
      <button class="mrow" data-a="install-open"><span>📲 Add to home screen</span><span class="mrow-end">›</span></button>
      <div class="mrow mrow-static"><span>📶 Works offline</span><span class="mrow-end">always</span></div>
      <div class="mrow mrow-static"><span>🔒 Private</span><span class="mrow-end">no account, no cloud</span></div>
    </div>

    <div class="card list-card danger-card">
      <button class="mrow mrow-danger" data-a="erase-open"><span>🗑️ Erase all data</span><span class="mrow-end">›</span></button>
    </div>
    <p class="finehint center">Barbershop v1.0 · ${jobs.length} jobs · ${expenses.length} expenses on record</p>
    <input type="file" id="restore-file" accept=".json,application/json" hidden>`;

  $('#name-input').addEventListener('change', async (e) => {
    settings.name = e.target.value.trim();
    await saveSettings();
    renderTopbar();
    showToast('<span class="toast-text">Name saved</span>');
  });
  $('#restore-file').addEventListener('change', onRestoreFile);
}

/* ------------------------------------------------------------- numpad */
let numpadState = null;
function openNumpad(title, onDone) {
  numpadState = { digits: '', onDone };
  openSheet(`
    <h2 class="sheet-title">${esc(title)}</h2>
    <p class="np-display num" id="np-display">$0.00</p>
    <div class="np-grid">
      ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => `<button class="np-key" data-a="np" data-v="${d}">${d}</button>`).join('')}
      <button class="np-key np-soft" data-a="np" data-v="00">00</button>
      <button class="np-key" data-a="np" data-v="0">0</button>
      <button class="np-key np-soft" data-a="np" data-v="bk">⌫</button>
    </div>
    <button class="btn-primary" data-a="np-done">Done</button>`);
}
function npPress(v) {
  if (!numpadState) return;
  if (v === 'bk') numpadState.digits = numpadState.digits.slice(0, -1);
  else if (numpadState.digits.length + v.length <= 7) numpadState.digits += v;
  $('#np-display').textContent = fmt$(parseInt(numpadState.digits || '0', 10));
}

/* -------------------------------------------------------- job edit sheet */
function openJobSheet(id) {
  const j = jobs.find((x) => x.id === id);
  if (!j) return;
  openSheet(`
    <h2 class="sheet-title">Edit job</h2>
    <p class="sheet-sub">${esc(j.services.map((s) => s.name).join(' + ') || 'Job')} · ${esc(fmtDayLong(j.ts))}, ${esc(fmtTime(j.ts))}</p>
    <label class="f-label">Amount</label>
    <input id="ej-amount" class="text-input num" type="text" inputmode="decimal" value="${(j.amount / 100).toFixed(2)}">
    <label class="f-label">Paid by</label>
    <div class="seg" id="ej-method">
      <button class="seg-btn ${j.method === 'cash' ? 'on' : ''}" data-a="ej-method" data-v="cash">💵 Cash</button>
      <button class="seg-btn ${j.method === 'card' ? 'on' : ''}" data-a="ej-method" data-v="card">💳 Card</button>
    </div>
    <label class="f-label">Tip</label>
    <input id="ej-tip" class="text-input num" type="text" inputmode="decimal" value="${(j.tip / 100).toFixed(2)}">
    <label class="f-label">Tip paid by</label>
    <div class="seg" id="ej-tipmethod">
      <button class="seg-btn ${j.tipMethod === 'cash' ? 'on' : ''}" data-a="ej-tipmethod" data-v="cash">💵 Cash</button>
      <button class="seg-btn ${j.tipMethod === 'card' ? 'on' : ''}" data-a="ej-tipmethod" data-v="card">💳 Card</button>
    </div>
    <label class="f-label">Note</label>
    <input id="ej-note" class="text-input" type="text" maxlength="80" value="${esc(j.note || '')}" placeholder="Client name or note…">
    <div class="sheet-actions">
      <button class="btn-danger" data-a="ej-delete" data-id="${j.id}">Delete</button>
      <button class="btn-primary" data-a="ej-save" data-id="${j.id}">Save</button>
    </div>`);
}
async function saveJobEdit(id) {
  const j = jobs.find((x) => x.id === id);
  if (!j) return;
  const amount = parse$($('#ej-amount').value);
  const tip = parse$($('#ej-tip').value === '' ? '0' : $('#ej-tip').value);
  if (amount === null || amount <= 0) { showToast('<span class="toast-text">⚠️ Enter a valid amount</span>'); return; }
  if (tip === null) { showToast('<span class="toast-text">⚠️ Enter a valid tip (or 0)</span>'); return; }
  const upd = {
    ...j, amount, tip,
    method: $('#ej-method .on').dataset.v,
    tipMethod: $('#ej-tipmethod .on').dataset.v,
    note: $('#ej-note').value.trim(),
  };
  await updateJob(upd);
  closeSheet(); renderActive();
  showToast('<span class="toast-text">Job updated</span>');
}

/* ------------------------------------------------------- expense sheet */
function openExpenseSheet(id) {
  const x = id ? expenses.find((e) => e.id === id) : null;
  const today = dayKey(now());
  const cat = x ? x.category : settings.categories[0] || 'Other';
  openSheet(`
    <h2 class="sheet-title">${x ? 'Edit expense' : 'Add expense'}</h2>
    <label class="f-label">Amount</label>
    <input id="ex-amount" class="text-input num" type="text" inputmode="decimal" placeholder="0.00" value="${x ? (x.amount / 100).toFixed(2) : ''}">
    <label class="f-label">Category</label>
    <div class="chip-row" id="ex-cats">
      ${settings.categories.map((c) => `<button class="chip ${c === cat ? 'on' : ''}" data-a="ex-cat" data-v="${esc(c)}">${esc(c)}</button>`).join('')}
    </div>
    <label class="f-label">Note (optional)</label>
    <input id="ex-note" class="text-input" type="text" maxlength="80" value="${esc(x ? x.note : '')}" placeholder="e.g. clippers, week 24 rent…">
    <label class="f-label">Date</label>
    <input id="ex-date" class="text-input" type="date" value="${x ? dayKey(x.ts) : today}" max="${today}">
    <div class="sheet-actions">
      ${x ? `<button class="btn-danger" data-a="ex-delete" data-id="${x.id}">Delete</button>` : ''}
      <button class="btn-primary" data-a="ex-save" ${x ? `data-id="${x.id}"` : ''}>Save</button>
    </div>`);
}
async function saveExpense(id) {
  const amount = parse$($('#ex-amount').value);
  if (amount === null || amount <= 0) { showToast('<span class="toast-text">⚠️ Enter a valid amount</span>'); return; }
  const catBtn = $('#ex-cats .on');
  const dateStr = $('#ex-date').value || dayKey(now());
  const [yy, mm, dd] = dateStr.split('-').map(Number);
  const ts = new Date(yy, mm - 1, dd, 12, 0, 0).getTime();
  const rec = {
    id: id || uid(), ts, amount,
    category: catBtn ? catBtn.dataset.v : 'Other',
    note: $('#ex-note').value.trim(),
  };
  if (id) await updateExpense(rec); else await addExpense(rec);
  closeSheet(); renderActive();
  showToast(`<span class="toast-text">Expense saved · −${esc(fmt$(amount))}</span>`);
}

/* --------------------------------------------------------- EOD sheet */
function openEOD() {
  const from = startOfDay(now());
  const c = collect(from, from + DAY);
  let tipsCash = 0, tipsCard = 0;
  for (const j of jobs) {
    if (j.ts < from || j.ts >= from + DAY) continue;
    if (j.tipMethod === 'cash') tipsCash += j.tip; else tipsCard += j.tip;
  }
  openSheet(`
    <h2 class="sheet-title">End of day</h2>
    <p class="sheet-sub">${esc(new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }))}</p>
    <div class="card tint-peach eod-cash">
      <p class="label">💵 Cash to count</p>
      <p class="huge num">${fmt$(c.cash)}</p>
      <p class="sub">includes ${fmt$(tipsCash)} cash tips</p>
    </div>
    <div class="eod-rows">
      <div class="eod-row"><span>💳 Card total</span><span class="num">${fmt$(c.card)}</span></div>
      <div class="eod-row"><span>Tips (cash / card)</span><span class="num">${fmt$(tipsCash)} / ${fmt$(tipsCard)}</span></div>
      <div class="eod-row"><span>✂️ Cuts</span><span class="num">${c.count}</span></div>
      <div class="eod-row"><span>Expenses today</span><span class="num">−${fmt$(c.expenses)}</span></div>
      <div class="eod-row eod-net"><span>Net for the day</span><span class="num">${fmt$(c.net)}</span></div>
    </div>
    <button class="btn-primary" data-a="sheet-close">Done ✂️</button>`);
}

/* ------------------------------------------------ services & categories */
function openServicesSheet() {
  openSheet(`
    <h2 class="sheet-title">Services &amp; prices</h2>
    <p class="sheet-sub">These become your one-tap buttons on the Log screen.</p>
    <div class="svc-list">
      ${settings.services.map((s, i) => `
        <div class="svc-row">
          <span class="svc-row-name">${esc(s.name)} <em class="num">${fmt$(s.price)}</em></span>
          <span class="svc-row-btns">
            <button class="icon-btn" data-a="svc-move" data-id="${s.id}" data-v="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
            <button class="icon-btn" data-a="svc-move" data-id="${s.id}" data-v="1" ${i === settings.services.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
            <button class="icon-btn" data-a="svc-edit" data-id="${s.id}" aria-label="Edit">✎</button>
            <button class="icon-btn icon-danger" data-a="svc-delete" data-id="${s.id}" aria-label="Delete">✕</button>
          </span>
        </div>`).join('') || '<div class="empty-mini">No services yet.</div>'}
    </div>
    <button class="btn-primary" data-a="svc-add">＋ Add service</button>`);
}
function openServiceForm(id) {
  const s = id ? settings.services.find((x) => x.id === id) : null;
  openSheet(`
    <h2 class="sheet-title">${s ? 'Edit service' : 'New service'}</h2>
    <label class="f-label">Name</label>
    <input id="sf-name" class="text-input" type="text" maxlength="24" placeholder="e.g. Haircut" value="${esc(s ? s.name : '')}">
    <label class="f-label">Price</label>
    <input id="sf-price" class="text-input num" type="text" inputmode="decimal" placeholder="35.00" value="${s ? (s.price / 100).toFixed(2) : ''}">
    <div class="sheet-actions">
      <button class="btn-ghost" data-a="services-open">Back</button>
      <button class="btn-primary" data-a="svc-save" ${s ? `data-id="${s.id}"` : ''}>Save</button>
    </div>`);
  setTimeout(() => $('#sf-name').focus(), 60);
}
async function saveService(id) {
  const name = $('#sf-name').value.trim();
  const price = parse$($('#sf-price').value);
  if (!name) { showToast('<span class="toast-text">⚠️ Give it a name</span>'); return; }
  if (price === null || price <= 0) { showToast('<span class="toast-text">⚠️ Enter a valid price</span>'); return; }
  if (id) {
    const s = settings.services.find((x) => x.id === id);
    s.name = name; s.price = price;
  } else {
    settings.services.push({ id: uid(), name, price });
  }
  await saveSettings();
  openServicesSheet();
  if (ui.tab === 'log') renderLog(); else renderActive();
}

function openCategoriesSheet() {
  openSheet(`
    <h2 class="sheet-title">Expense categories</h2>
    <div class="svc-list">
      ${settings.categories.map((c) => `
        <div class="svc-row">
          <span class="svc-row-name">${esc(c)}</span>
          <span class="svc-row-btns">
            <button class="icon-btn icon-danger" data-a="cat-delete" data-v="${esc(c)}" ${settings.categories.length <= 1 ? 'disabled' : ''} aria-label="Delete">✕</button>
          </span>
        </div>`).join('')}
    </div>
    <div class="addcat-row">
      <input id="cat-new" class="text-input" type="text" maxlength="20" placeholder="New category…">
      <button class="btn-primary btn-slim" data-a="cat-add">Add</button>
    </div>`);
}

/* ----------------------------------------------------- install / erase */
function openInstallSheet() {
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  let body;
  if (standalone) {
    body = `<div class="empty-mini">✅ You're already running the installed app — nothing to do.</div>`;
  } else if (deferredInstall) {
    body = `<p class="sheet-sub">One tap installs Barbershop on your home screen.</p>
      <button class="btn-primary" data-a="install-now">📲 Install now</button>`;
  } else if (isIOS) {
    body = `<ol class="steps">
      <li>Open this page in <strong>Safari</strong></li>
      <li>Tap the <strong>Share</strong> button <span class="kbd">⬆️</span> at the bottom</li>
      <li>Scroll and tap <strong>“Add to Home Screen”</strong></li>
      <li>Tap <strong>Add</strong> — done. It opens full-screen and works offline.</li>
    </ol>`;
  } else {
    body = `<ol class="steps">
      <li>Open the browser menu <span class="kbd">⋮</span></li>
      <li>Tap <strong>“Add to Home screen”</strong> (or “Install app”)</li>
      <li>Confirm — it opens full-screen and works offline.</li>
    </ol>`;
  }
  openSheet(`<h2 class="sheet-title">Add to home screen</h2>${body}
    <button class="btn-ghost" data-a="sheet-close">Close</button>`);
}

function openEraseSheet() {
  openSheet(`
    <h2 class="sheet-title">Erase all data</h2>
    <p class="sheet-sub">⚠️ This permanently deletes <strong>${jobs.length} jobs</strong> and <strong>${expenses.length} expenses</strong> from this phone. There is no undo. Consider backing up first.</p>
    <label class="check-row"><input type="checkbox" id="erase-ok"> I understand — erase everything</label>
    <div class="sheet-actions">
      <button class="btn-ghost" data-a="sheet-close">Cancel</button>
      <button class="btn-danger" data-a="erase-confirm">Erase</button>
    </div>`);
}
async function eraseAll() {
  if (!$('#erase-ok')?.checked) { showToast('<span class="toast-text">Tick the box to confirm</span>'); return; }
  await dbClear('jobs'); await dbClear('expenses');
  jobs = []; expenses = [];
  settings.lastBackup = 0;
  await saveSettings();
  closeSheet(); renderAll();
  showToast('<span class="toast-text">All data erased</span>');
}

/* -------------------------------------------------------- onboarding */
function openOnboarding() {
  openSheet(`
    <h2 class="sheet-title">Welcome to Barbershop 👋</h2>
    <p class="sheet-sub">Log every cut in two taps. Cash vs card, tips and totals — all private, all on your phone.</p>
    <label class="f-label">Your name (optional)</label>
    <input id="ob-name" class="text-input" type="text" maxlength="30" placeholder="e.g. Josiah">
    <label class="f-label">Your starter menu — edit anytime</label>
    <div class="ob-menu">
      ${settings.services.map((s) => `<span class="chip">${esc(s.name)} · ${fmt$(s.price)}</span>`).join('')}
    </div>
    <div class="sheet-actions">
      <button class="btn-ghost" data-a="ob-edit-menu">Edit my menu</button>
      <button class="btn-primary" data-a="ob-start">Start cutting ✂️</button>
    </div>`, { locked: true });
}
async function finishOnboarding(editMenu) {
  settings.name = ($('#ob-name')?.value || '').trim();
  settings.onboarded = true;
  await saveSettings();
  requestPersist();
  closeSheet(); renderAll();
  if (editMenu) openServicesSheet();
}

/* ----------------------------------------------------- export / backup */
function download(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
const csvCell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

function exportCSV() {
  const header = ['type', 'date', 'time', 'description', 'method', 'amount', 'tip', 'tip_method', 'category', 'note'];
  const rows = [];
  for (const j of jobs) rows.push(['job', dayKey(j.ts), fmtTime(j.ts),
    j.services.map((s) => s.name).join(' + '), j.method,
    (j.amount / 100).toFixed(2), (j.tip / 100).toFixed(2), j.tip > 0 ? j.tipMethod : '', '', j.note || '']);
  for (const x of expenses) rows.push(['expense', dayKey(x.ts), '', '', '',
    (-x.amount / 100).toFixed(2), '', '', x.category, x.note || '']);
  rows.sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  download(`barbershop-${dayKey(now())}.csv`,
    [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n'), 'text/csv');
  showToast('<span class="toast-text">CSV exported 📄</span>');
}

async function exportBackup() {
  const data = { app: 'barbershop', version: 1, exportedAt: new Date().toISOString(), settings, jobs, expenses };
  download(`barbershop-backup-${dayKey(now())}.json`, JSON.stringify(data, null, 1), 'application/json');
  settings.lastBackup = now();
  await saveSettings();
  requestPersist();
  renderActive();
  showToast('<span class="toast-text">Backup saved 🛟 Keep it somewhere safe</span>');
}

let pendingRestore = null;
function onRestoreFile(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (data.app !== 'barbershop' || !Array.isArray(data.jobs) || !Array.isArray(data.expenses) || typeof data.settings !== 'object') {
        throw new Error('not a barbershop backup');
      }
      pendingRestore = data;
      openSheet(`
        <h2 class="sheet-title">Restore backup?</h2>
        <p class="sheet-sub">This file has <strong>${data.jobs.length} jobs</strong> and <strong>${data.expenses.length} expenses</strong>${data.exportedAt ? ` (saved ${esc(new Date(data.exportedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }))})` : ''}.<br><br>⚠️ Restoring <strong>replaces</strong> the ${jobs.length} jobs and ${expenses.length} expenses currently on this phone.</p>
        <div class="sheet-actions">
          <button class="btn-ghost" data-a="sheet-close">Cancel</button>
          <button class="btn-primary" data-a="restore-confirm">Restore</button>
        </div>`);
    } catch (err) {
      showToast('<span class="toast-text">⚠️ That file isn\'t a Barbershop backup</span>');
    }
  };
  reader.readAsText(file);
}
async function doRestore() {
  if (!pendingRestore) return;
  const data = pendingRestore; pendingRestore = null;
  await dbClear('jobs'); await dbClear('expenses');
  const cleanJobs = data.jobs.filter((j) => j && j.id && typeof j.ts === 'number' && typeof j.amount === 'number');
  const cleanExp = data.expenses.filter((x) => x && x.id && typeof x.ts === 'number' && typeof x.amount === 'number');
  for (const j of cleanJobs) await dbPut('jobs', j);
  for (const x of cleanExp) await dbPut('expenses', x);
  settings = Object.assign(settings, data.settings, { onboarded: true });
  await saveSettings();
  jobs = cleanJobs.sort((a, b) => a.ts - b.ts);
  expenses = cleanExp.sort((a, b) => a.ts - b.ts);
  closeSheet(); renderAll();
  showToast(`<span class="toast-text">Restored ${jobs.length} jobs ✅</span>`);
}

/* ---------------------------------------------------------- top bar */
function renderTopbar() {
  $('#greeting').textContent = settings.name ? `Welcome back, ${settings.name}` : 'Welcome back';
  $('#dateline').textContent = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

/* --------------------------------------------------------- navigation */
function switchTab(tab) {
  ui.tab = tab;
  $$('#tabbar .tab').forEach((b) => b.classList.toggle('active', b.dataset.v === tab));
  $$('.screen').forEach((s) => s.classList.toggle('active', s.dataset.screen === tab));
  renderActive();
  $('#main').scrollTo({ top: 0 });
}
function renderActive() {
  ({ log: renderLog, dash: renderDash, history: renderHistory, more: renderMore }[ui.tab])();
}
function renderAll() { renderTopbar(); renderActive(); }

/* ------------------------------------------------------ event delegation */
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; });

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-a]');
  if (!btn) return;
  const a = btn.dataset.a, v = btn.dataset.v, id = btn.dataset.id;
  switch (a) {
    case 'noop': break;
    case 'tab': switchTab(v); break;
    case 'goto-dash': switchTab('dash'); break;
    case 'goto-more': switchTab('more'); break;

    /* log */
    case 'svc':
      if (ui.log.sel.has(id)) ui.log.sel.delete(id); else ui.log.sel.add(id);
      vibrate(8); renderLog(); break;
    case 'custom-add':
      openNumpad('Custom amount', (cents) => {
        if (cents > 0) ui.log.custom.push(cents);
        closeSheet(); renderLog();
      }); break;
    case 'custom-remove':
      ui.log.custom.splice(Number(btn.dataset.i), 1); renderLog(); break;
    case 'tip':
      ui.log.tip = Number(v); ui.log.tipIsCustom = false;
      if (ui.log.tip === 0) ui.log.tipFlip = false;
      renderLog(); break;
    case 'tip-custom':
      openNumpad('Tip amount', (cents) => {
        ui.log.tip = cents; ui.log.tipIsCustom = cents > 0;
        if (cents === 0) ui.log.tipFlip = false;
        closeSheet(); renderLog();
      }); break;
    case 'tip-flip': ui.log.tipFlip = !ui.log.tipFlip; renderLog(); break;
    case 'note-open': ui.log.noteOpen = true; renderLog(); $('#job-note')?.focus(); break;
    case 'pay': await payJob(v); break;
    case 'undo':
      await deleteJob(id); hideToast(); renderActive();
      showToast('<span class="toast-text">Removed 👍</span>', { ms: 2000 }); break;

    /* dashboard */
    case 'period': ui.dashPeriod = v; renderDash(); break;
    case 'eod-open': openEOD(); break;
    case 'nudge-dismiss':
      e.stopPropagation();
      settings.nudgeDismissed = now(); await saveSettings(); renderDash(); break;

    /* history */
    case 'month': {
      let m = ui.historyM + Number(v), y = ui.historyY;
      if (m < 0) { m = 11; y--; } if (m > 11) { m = 0; y++; }
      ui.historyM = m; ui.historyY = y; renderHistory(); break;
    }
    case 'edit-job': openJobSheet(id); break;
    case 'edit-exp': openExpenseSheet(id); break;

    /* sheets */
    case 'sheet-close': closeSheet(); break;
    case 'np': npPress(v); break;
    case 'np-done': {
      const cents = parseInt(numpadState?.digits || '0', 10);
      const cb = numpadState?.onDone; numpadState = null;
      if (cb) cb(cents); break;
    }
    case 'ej-method': case 'ej-tipmethod':
      $$('.seg-btn', btn.parentElement).forEach((b) => b.classList.toggle('on', b === btn)); break;
    case 'ej-save': await saveJobEdit(id); break;
    case 'ej-delete':
      await deleteJob(id); closeSheet(); renderActive();
      showToast('<span class="toast-text">Job deleted</span>'); break;

    /* expenses */
    case 'expense-open': openExpenseSheet(null); break;
    case 'ex-cat':
      $$('.chip', btn.parentElement).forEach((b) => b.classList.toggle('on', b === btn)); break;
    case 'ex-save': await saveExpense(id || null); break;
    case 'ex-delete':
      await deleteExpense(id); closeSheet(); renderActive();
      showToast('<span class="toast-text">Expense deleted</span>'); break;

    /* services */
    case 'services-open': openServicesSheet(); break;
    case 'svc-add': openServiceForm(null); break;
    case 'svc-edit': openServiceForm(id); break;
    case 'svc-save': await saveService(id || null); break;
    case 'svc-delete': {
      settings.services = settings.services.filter((s) => s.id !== id);
      await saveSettings(); openServicesSheet();
      if ($('#screen-log').classList.contains('active')) renderLog();
      break;
    }
    case 'svc-move': {
      const i = settings.services.findIndex((s) => s.id === id);
      const j2 = i + Number(v);
      if (i >= 0 && j2 >= 0 && j2 < settings.services.length) {
        [settings.services[i], settings.services[j2]] = [settings.services[j2], settings.services[i]];
        await saveSettings(); openServicesSheet();
      }
      break;
    }

    /* categories */
    case 'categories-open': openCategoriesSheet(); break;
    case 'cat-add': {
      const inp = $('#cat-new');
      const name = (inp.value || '').trim();
      if (!name) break;
      if (!settings.categories.includes(name)) settings.categories.push(name);
      await saveSettings(); openCategoriesSheet(); break;
    }
    case 'cat-delete':
      settings.categories = settings.categories.filter((c) => c !== v);
      await saveSettings(); openCategoriesSheet(); break;

    /* data */
    case 'export-csv': exportCSV(); break;
    case 'backup': await exportBackup(); break;
    case 'restore-pick': $('#restore-file').click(); break;
    case 'restore-confirm': await doRestore(); break;
    case 'erase-open': openEraseSheet(); break;
    case 'erase-confirm': await eraseAll(); break;

    /* install */
    case 'install-open': openInstallSheet(); break;
    case 'install-now':
      if (deferredInstall) { deferredInstall.prompt(); deferredInstall = null; }
      closeSheet(); break;
    case 'install-dismiss':
      e.stopPropagation();
      settings.installDismissed = true; await saveSettings(); renderLog(); break;

    /* onboarding */
    case 'ob-start': await finishOnboarding(false); break;
    case 'ob-edit-menu': await finishOnboarding(true); break;
  }
});

/* --------------------------------------------------------- dev helpers */
window.__bb = {
  async seed(days = 90) {
    const names = settings.services.length ? settings.services : DEFAULT_SERVICES;
    let r = 42;
    const rand = () => { r = (r * 1103515245 + 12345) % 2147483648; return r / 2147483648; };
    for (let d = days; d >= 0; d--) {
      const base = startOfDay(now()) - d * DAY;
      const nJobs = 4 + Math.floor(rand() * 9);
      for (let k = 0; k < nJobs; k++) {
        const s = names[Math.floor(rand() * names.length)];
        const method = rand() < 0.45 ? 'cash' : 'card';
        const tip = rand() < 0.6 ? [500, 500, 1000, 2000][Math.floor(rand() * 4)] : 0;
        await addJob({
          id: uid(), ts: base + 9 * 3600000 + Math.floor(rand() * 9 * 3600000),
          services: [{ name: s.name, price: s.price }], amount: s.price,
          method, tip, tipMethod: method, note: '',
        });
      }
      if (d % 7 === 0) await addExpense({ id: uid(), ts: base + 12 * 3600000, amount: 25000, category: 'Booth rent', note: 'weekly booth' });
    }
    renderAll();
    return `${jobs.length} jobs, ${expenses.length} expenses`;
  },
  async wipe() {
    await dbClear('jobs'); await dbClear('expenses');
    jobs = []; expenses = []; renderAll(); return 'wiped';
  },
};

/* ---------------------------------------------------------------- init */
async function init() {
  try {
    await loadState();
  } catch (err) {
    document.body.innerHTML = `<div class="fatal">Couldn't open local storage (${esc(err && err.message)}). If you're in a private/incognito window, open Barbershop in a normal window.</div>`;
    return;
  }
  renderAll();
  if (!settings.onboarded) openOnboarding();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline still fine on next load */ });
  }
  // refresh "today" numbers if the app sat open across midnight or in background
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { renderTopbar(); renderActive(); }
  });
}
init();
