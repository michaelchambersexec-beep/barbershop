# Barbershop ✂️

A free, installable web app (PWA) for barbers: log every cut in ~2 seconds and
see clean daily / monthly / yearly numbers split by **cash vs card**.

- **Private by design** — no account, no cloud; everything lives on the phone
  (IndexedDB), with one-tap backup/restore and CSV export.
- **Works fully offline** — service worker caches the whole app.
- **Zero dependencies** — plain HTML/CSS/JS. No build step.

## Run locally

Any static file server works:

```sh
python3 -m http.server 4173
# open http://localhost:4173
```

## Deploy (free)

The app is just static files — host the folder anywhere:

- **Netlify**: drag the folder onto https://app.netlify.com/drop
- **GitHub Pages**: push to a repo → Settings → Pages → deploy from branch
- **Cloudflare Pages / Vercel**: import the repo, no build command needed

Must be served over **HTTPS** (or localhost) for the service worker and
Add-to-Home-Screen install to work. Then share the URL — each barber who adds
it to their home screen gets their own private tracker.

## Shipping an update

Edit the files and redeploy. The service worker uses stale-while-revalidate:
running apps refresh their cache in the background and pick up the new
version on the next launch. (No cache-version bump needed.)

## Files

| File | Purpose |
|---|---|
| `index.html` | App shell |
| `app.js` | All logic — data layer (IndexedDB, integer cents), screens, sheets |
| `styles.css` | Design system + components |
| `sw.js` | Offline service worker |
| `manifest.json` + icons | Install / home-screen metadata |
| `SPEC.md` | Full product spec |

## Dev helpers

In the browser console: `__bb.seed(90)` fills ~90 days of fake data,
`__bb.wipe()` clears all records. (Local to that browser only.)
