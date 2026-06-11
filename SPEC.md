# Barbershop — Final Build Spec (v1)

Offline-first PWA for barbers: log every job in ~2 seconds, see clean
daily/monthly/yearly numbers split by cash vs card. Distributed as a free
link; all data lives on the phone. No backend, no accounts.

---

## 1. Design system (from Starline inspiration)

Light, soft, premium. White cards floating on a warm gray canvas, pastel
tinted stat cards, one energetic lime accent, big confident numbers.

### Tokens
- **Canvas:** `#F1F1EF` (warm light gray)
- **Card:** `#FFFFFF`, radius 20px, shadow `0 1px 3px rgba(0,0,0,.06)`
- **Text:** primary `#191919`, secondary `#8A8A86`
- **Accent — lime:** `#D9F462` (active states, selection, progress, chart highlight chips)
- **Tint — peach:** `#FBEDDF` with icon/accent `#F2A33C` → used for **Cash**
- **Tint — lavender:** `#ECE7FA` with accent `#8B5CF6` → used for **Card**
- **Tint — mint:** `#DFF3EE` with accent `#2BB596` → tips / positive
- **Success green:** `#34A853` (trend chips “↑ 10.5%”)
- **Danger:** `#E5484D` (delete, expenses chip)
- **Type:** system font stack (SF Pro on iOS); numbers in heavy weight,
  tabular-nums so totals don’t jiggle; labels small, medium-gray
- **Shape language:** everything pill or 16–20px rounded; icon chips in
  small rounded squares like the inspiration’s sidebar
- **Spacing:** 16px page gutter, 12px card gaps; generous padding — airy, never cramped

### Mobile layout
- Bottom tab bar (white pill bar, lime highlight on active tab):
  **Log · Dashboard · History · More**
- Top of each screen: small greeting/date line, like “Welcome, Josiah”.
- Designed at 390×844 (iPhone), must hold up 360–430px wide, and respect
  safe-area insets when installed to home screen.

---

## 2. Screens

### 2.1 Log (opens here — the most important screen)
Optimized for one hand, busy hands, between clients.

**Layout, top to bottom:**
1. **Today strip** — one slim white card: today’s total (big), then
   `Cash $X · Card $Y · N cuts` in small secondary text. Tappable → Dashboard.
2. **Service grid** — 2 columns of white card buttons, each: service name +
   price in bold (`Haircut` / `$35`). Tap to select → card flips to lime
   with a check. Multi-select allowed (combo = tap Haircut + Beard);
   selected total shows in the pay buttons. Last cell: **Custom** → opens a
   big-key numpad sheet.
3. **Tip row** — horizontal chips: `No tip · $5 · $10 · Custom`. Default
   “No tip”. One tap, optional always.
4. **Pay buttons — the commit action.** Two huge half-width buttons:
   **Cash** (peach) and **Card** (lavender), each showing the live total
   incl. tip. Tapping one **saves the job instantly** and resets the screen.
5. **Confirmation:** toast slides up — “Saved · Haircut $35 + $5 tip · Card”
   with an **Undo** button (6s). Undo deletes the entry. Light haptic
   (vibration API) on save.

**Details:**
- Tip method defaults to the pay button tapped; long-press a tip chip (or a
  small toggle in the toast) flips tip to the other method (card job, cash tip).
- Optional client/note: small “＋ note” ghost button above pay buttons,
  expands a one-line field. Never required, never in the way.
- Disabled pay buttons until a service or custom amount is selected.
- Tap targets ≥ 48px everywhere; pay buttons ~72px tall.

### 2.2 Dashboard
Pastel stat cards in the inspiration’s style.

- **Period tabs:** `Today · Month · Year` (pill segmented control, lime active).
- **Hero card (peach tint):** total revenue for period, green/red trend chip
  vs previous equivalent period (“↑ 12% vs last month”).
- **Split row:** two tinted cards — **Cash** (peach) and **Card** (lavender),
  amount + % of total each.
- **Tips card (mint)** and **Expenses card** (white, red accent) →
  **Net profit** line: revenue − expenses, bold.
- **Trend chart:** clean bar chart, white card — last 14 days (Today tab),
  12 months (Month/Year tabs). Lime bar for current period, gray for past;
  value callout chip on the highlighted bar like the inspiration’s “21,345”.
- **Quick stats card:** cuts this period · avg ticket · avg tip — three
  columns like the inspiration’s “Sales / This Month / Today” card.
- **End the day** button (Today tab): opens End-of-day summary.

### 2.3 History
- Reverse-chronological, grouped by day with a day-header (date + day total).
- Each row: service(s) · time · amount (+tip) · cash/card icon chip
  (peach/lavender dot). Expense rows show red category chip.
- Tap row → bottom sheet: edit any field or delete (confirm).
- Month picker at top to jump back.

### 2.4 End-of-day summary
Clean closing card: date, **cash to count** (big — drawer reconciliation),
card total, tips split by method, cut count, expenses logged today, net.
“Share/screenshot-friendly” layout.

### 2.5 Expenses (under More, plus quick-add from Dashboard)
Amount (numpad), category chips (Booth rent · Supplies · Equipment · Other),
optional note, date (defaults today). Saved expenses appear in History.

### 2.6 More / Settings
- **Services:** add/edit/remove (name, price), drag to reorder. These drive
  the Log grid.
- **Expense categories:** rename/add.
- **Export CSV** — jobs + expenses, accountant-friendly columns.
- **Backup** — downloads one JSON file; **Restore** — import it on a new
  phone (with “this replaces current data” confirm).
- **About/install hint** for Add to Home Screen.

### 2.7 First run
Seeded starter services (Haircut $35, Beard $20, Lineup $15, Combo $50)
with a friendly “Set your menu & prices” card prompting one-time edit —
the barber can start logging immediately and tune prices later.

---

## 3. Data model

```js
job:     { id, ts, services: [{name, price}], amount, method: 'cash'|'card',
           tip, tipMethod, note }
expense: { id, date, amount, category, note }
settings:{ services: [{id, name, price, order}], categories: [...],
           name?, onboarded }
```

- Storage: **IndexedDB** (via a tiny hand-rolled wrapper — no dependencies),
  `settings` mirrored in localStorage for instant first paint.
- All money stored as **integer cents** to avoid float errors.
- Derived stats are computed, never stored.

## 4. Tech

- **Plain HTML/CSS/JS, single-page, zero dependencies** — no framework, no
  build step. One `index.html` + `app.js` + `styles.css` + `sw.js` +
  `manifest.json` + icons. Trivial to host on GitHub Pages/Netlify.
- Service worker: cache-first app shell → fully offline after first load.
- Manifest: standalone display, theme color matching canvas, app icons
  (simple lime/charcoal scissors or pole mark, generated as SVG→PNG).
- Chart drawn with lightweight inline SVG (no chart library).

## 5. Operational soundness (barber-shoes checklist)

Built-in behaviors that come from imagining the working day:
- **Undo over confirm** — never slow down a save; make mistakes reversible.
- **Mis-tap tolerance** — large targets, debounce double-taps so one job
  isn’t logged twice.
- **Drawer math** — end-of-day leads with cash (what he physically counts).
- **No dead ends** — every empty state says what to do (“No cuts yet today —
  log your first below”).
- **Survives phone loss** — backup/restore is first-class, with a gentle
  periodic “back up your data” nudge (e.g. monthly, dismissible).
- **Fast cold open** — instant paint from cached shell; today’s numbers
  render before anything else.
- During the build I’ll keep stepping into the barber’s shoes; if a better
  flow or missing piece shows up, I build it and note it in the final report.

## 6. Test plan (executed in a real browser before delivery)

Using the preview browser at iPhone viewport (390×844), plus 360px and
430px checks:

1. **Full simulated workday:** onboard → adjust a service price → log 12+
   jobs across cash/card, with/without tips, combo (multi-select), custom
   amount, a flipped tip method, a note → verify Today strip after each.
2. **Mistake paths:** wrong service mis-tap then undo; edit a job in
   History; delete a job; verify totals recompute everywhere.
3. **Math audit:** hand-compute expected day totals (cash, card, tips, net
   with an expense) and assert dashboard, history headers, and end-of-day
   all agree to the cent.
4. **Periods:** seed multi-day/multi-month data via the data layer; verify
   Month/Year tabs, trend chart bars, averages, and trend-vs-last-period chips.
5. **Persistence & offline:** reload mid-day (data survives), service-worker
   offline pass, fresh-profile first-run.
6. **Backup cycle:** export backup → wipe → restore → verify identical;
   export CSV and inspect columns/values.
7. **UI bug sweep:** every screen screenshotted at 3 widths; check overflow
   with long service names and $9,999+ totals; empty states; safe-area;
   tap targets; rapid double-tap on pay buttons; **zero console errors** as
   a hard gate.
8. Fix everything found, re-run the affected pass, repeat until clean.

## 7. Build order

1. Shell: layout, tabs, design tokens, manifest + service worker.
2. Data layer (IndexedDB, cents, CRUD) + settings/services.
3. Log screen end-to-end (the crown jewel) + Today strip + undo toast.
4. Dashboard (stats, split, chart, averages) → History (edit/delete).
5. Expenses, End-of-day, CSV export, backup/restore, onboarding.
6. Full test plan (above), fix, polish pass, final screenshots.
