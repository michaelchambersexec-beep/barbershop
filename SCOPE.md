# Barbershop — Project Scope (v1)

A free, installable web app (PWA) for barbers to track revenue with a clean
cash-vs-card split. Built as a product for many barbers: anyone opens the
link, adds it to their home screen, and has their own private tracker.

## Core decisions (from interview)

| Decision | Choice |
|---|---|
| Audience | Any barber — distributed as a free shareable link |
| Platform | PWA: single web app, "Add to Home Screen", works fully offline |
| Data | Stored on the phone only (IndexedDB). No accounts, no backend, no cost |
| Safety net | Backup file export/restore + CSV export (required, since data is device-only) |
| Money tracked | Revenue **and** expenses (categorized) → dashboard shows net profit |

## Screens

### 1. Entry screen (the app opens here)
- Slim "Today so far" strip on top: total, cash/card split, job count.
- Grid of **preset service buttons** (Haircut $35, Beard $20, …) the barber
  configures once in Settings. Combos supported by tapping multiple services
  or defining a combo preset.
- Flow: tap service → tap **Cash** or **Card** → done (~2 seconds).
- Optional per job, never required:
  - **Tip**: quick buttons ($5 / $10 / custom). Tip inherits the job's
    payment method but can be flipped (card payment, cash tip).
  - **Client name / note**: small free-text field.
- Custom-amount path for one-off prices.

### 2. Dashboard
- **Day / Month / Year** tabs.
- Each view: total revenue, **cash vs card** split (the headline feature),
  tips total, expenses total, **net profit**.
- **Trend chart**: simple bars — last 14 days (day view), last 12 months
  (month/year views).
- **Averages & counts**: jobs per day, average ticket, average tip.

### 3. History
- Reverse-chronological list of jobs and expenses, grouped by day.
- Tap any entry to **edit or delete** (fix mistakes).

### 4. End-of-day summary
- Closing screen for any day: cash total (to count against the drawer),
  card total, tips by method, job count, expenses logged.

### 5. Expenses
- Quick form: amount, **category** (booth rent, supplies, equipment, other),
  optional note, date.

### 6. Settings
- Service menu editor (name, price, button order/color).
- Expense category management.
- **Export CSV** (jobs + expenses, accountant/tax friendly).
- **Backup** (single file download) and **Restore** (import on a new phone).

## First-run onboarding
On first open: short setup — "Add your services and prices" — with sensible
starter defaults (Haircut, Beard, Lineup, Combo) the barber can edit or
accept. Then a one-time hint to Add to Home Screen.

## Data model (sketch)

- **Job**: id, datetime, service(s), amount, payment method (cash/card),
  tip amount, tip method, optional note/client.
- **Expense**: id, date, amount, category, optional note.
- **Settings**: services list (name, price), categories, preferences.

## Tech approach

- Single-page app: HTML/CSS/JS, no framework lock-in required (can be plain
  or a light framework — decided at build time).
- IndexedDB for records (robust for thousands of entries), service worker
  for full offline use, web manifest for home-screen install.
- Hosting: GitHub Pages or Netlify — free, just a URL to share.
- No backend, no login, no personal data leaves the phone.

## Explicitly out of scope for v1

- Cloud sync / accounts / multi-device (possible future paid tier).
- Appointment booking, client CRM beyond the per-job note.
- Multi-barber shared shop view.
- Daily goal tracker, period-vs-period comparisons, service-earnings
  breakdown, auto-recurring rent — all easy later adds, deferred by choice.
- App store packaging (PWA first; wrappable later).

## Open item

**Visual design** — awaiting inspiration references from Mikael before any
styling decisions (palette, typography, overall vibe).

## Suggested build order

1. Skeleton PWA (installable, offline) + data layer + service menu setup.
2. Entry screen with presets, cash/card, tips, notes.
3. Dashboard (totals, splits, chart, averages) + history with edit/delete.
4. Expenses, end-of-day summary, CSV export, backup/restore.
5. Visual polish pass once design inspiration lands.
