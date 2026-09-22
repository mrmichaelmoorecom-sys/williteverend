# williteverend.com

**Will it ever end?** — a one-page site. Official portrait, a giant **NO** (until it isn't),
the days left in the term underneath, "chance it actually ends" from betting markets,
the raw odds, the approval average and a Drudge-style news feed. One Cloudflare Worker,
no framework, no build step.

## Layout

```
config.json          knobs: termEnd, override, president, links, newsQuery
wrangler.jsonc       Worker config (assets, KV "STATE", cron */10)
src/index.js         fetch (/, /api/state, /api/news) + scheduled (cron refresh)
src/lib/markets.js   Kalshi + Polymarket parsers → normalized rows
src/lib/snapshot.js  headline math (§1.6/§1.7), NO→YES rule (§1.8), groups, approval mean
src/lib/csv.js       NYT + Silver Bulletin (Datawrapper) CSV parsing
src/lib/rss.js       regex RSS parser, merge/dedupe (http(s) links only)
src/lib/schedule.js  which ONE heavy job (approval / election2028 / news) a cron tick runs
src/lib/render.js    server-side HTML for every section + template fill
public/index.html    template ({{placeholders}} filled by the Worker on every request)
public/style.css, public/app.js, public/portrait.jpg, public/portrait-full.jpg
test/*.test.js       node --test, fixtures in test/fixtures/
```

## Data flow

* Cron `*/10 * * * *`, every tick: Kalshi batch (1 call) + Polymarket keyset (1) + two 2028 slugs +
  the rolling "out by month-end" event → `buildSnapshot()` → KV `snapshot`. Then at most ONE heavy
  job, whichever is due (`src/lib/schedule.js`): **approval** (NYT + Silver Bulletin, every ~55 min),
  **election2028** (Kalshi `KXPRESPERSON-28` + the 445 KB Polymarket `presidential-election-winner-2028`
  event + monthly-market discovery, every ~55 min), **news** (four feeds → KV `news`, every tick
  nothing hourly is due). Progress is written after every job, so a fresh deploy converges in ~3 ticks.
* **CPU budget.** This assumes the Workers **Free** plan: 10 ms CPU per invocation, for HTTP requests
  and cron ticks alike (exceeding it consistently kills the invocation with error 1102 and nothing is
  written). Measured cold costs with these parsers: light refresh ≈ 6–8 ms, approval ≈ 2 ms,
  election2028 ≈ 5 ms, news ≈ 6 ms — no single invocation runs everything. The split is harmless on
  Workers Paid (30 s). After a deploy, check Worker → Metrics → "Errors by invocation status" for
  "Exceeded CPU Time Limits" and the observability logs' `cpuTimeMs` for scheduled events.
* `/` reads both KV keys, injects the snapshot into `public/index.html` (answer, countdown seed,
  headline odds, tables, approval, news, `<script id="state">`) and caches 60 s (keyed on path only,
  so `?utm_*`/`?fbclid=` variants share one entry). Works without JS. Sends a CSP, `nosniff`,
  `Referrer-Policy` and `X-Frame-Options: DENY`.
* `/api/state`, `/api/news`: JSON, CORS `*`, Cache API in front of KV. If KV is empty (cold start)
  the Worker runs the light market refresh inline (one in-flight refresh per isolate) so the page is
  never blank; approval, 2028 and news show "unavailable" until the first cron ticks.
* Per-source `ok` flags; when an upstream fails (including a 200 with an empty or half-missing market
  list), the previous good values are carried forward, `updatedAt` stops advancing (`stale: true`),
  and the UI says so. A 200 that omits a few expected markets is flagged `partial` with the missing ids.

## Headline math

* **Chance it actually ends** = 1 − clamp(mean(Kalshi, Polymarket "Trump wins 2028") + (1 − Kalshi "2028 election occurs")).
* **Chance it ends early** = max (not sum) of Kalshi leaves-office / resigns / impeached-and-removed / 25th Amendment.
* Thin markets (Kalshi spread > 0.05; Polymarket liquidity ≤ $5k or spread ≥ 0.05) are ignored when a solid venue exists.
* No market prices death; the page says so.

## Flip the answer

The answer flips to **YES** automatically when the term-end date passes, when Kalshi
`KXTRUMPOUT27-27-JAN2029` / `KXTRUMPREMOVE` / `KXTRUMPRESIGN` settles YES, or when Polymarket
`trump-out-as-president-before-2027` (or the current monthly market) resolves YES.

To flip it by hand: set `"override": "YES"` (or `"NO"`) in `config.json` and push (shows on the
next deploy). A quicker switch without a deploy writes the KV key on the **remote** namespace:

```bash
npx wrangler kv key put --binding STATE override YES --remote     # flip   (npm run flip)
npx wrangler kv key delete --binding STATE override --remote      # un-flip (npm run unflip)
```

* `--remote` is required: wrangler 4 defaults `kv key` commands to the LOCAL simulation
  (`.wrangler/state`), which "succeeds" silently (look for `Resource location: local`) and the live
  Worker never sees it. `--remote` needs a one-time `npx wrangler login` (or `CLOUDFLARE_API_TOKEN`).
* Un-flip by **deleting** the key, not by writing `NO`: a KV `NO` outranks the computed verdict and
  would pin NO even after the term ends or an exit market settles.
* Latency: the Worker reads `override` only inside the cron refresh (every 10 min) and `/` is
  edge-cached for 60 s, so a remote flip shows within ~11 minutes.
* `config.json` wins over KV, which wins over the computed answer.

## Develop

```bash
npm install
npm run dev        # http://localhost:8787
npm test           # node --test test/
curl "http://localhost:8787/cdn-cgi/local/scheduled"             # one cron tick: markets + the next due job
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=news"   # force a job: news | approval | election2028
```

## Deploy

Pushes to `main` auto-deploy via Cloudflare Workers Builds (`npx wrangler deploy`).
Manual: `npm run deploy`.

## Credits

Portrait: Official White House portrait, June 2025 (photo: Daniel Torok) — public domain, 17 U.S.C. § 105.
Odds: Kalshi, Polymarket · Approval: NYT polling average, Silver Bulletin · News: Google News, The Guardian, Politico, The Hill.
