# williteverend.com

**Will it ever end?** — a one-page site. Official portrait, a giant **NO** (until it isn't),
the days left in the term underneath, "chance it actually ends" from betting markets,
the raw odds, the approval average and a Drudge-style news feed. One Cloudflare Worker,
no framework, no build step.

## Layout

```
config.json          knobs: termEnd, override, president, links, newsQuery
wrangler.jsonc       Worker config (assets, KV "STATE", crons */10 and hourly)
src/index.js         fetch (/, /api/state, /api/news) + scheduled (cron refresh)
src/lib/markets.js   Kalshi + Polymarket parsers → normalized rows
src/lib/snapshot.js  headline math (§1.6/§1.7), NO→YES rule (§1.8), groups, approval mean
src/lib/csv.js       NYT + Silver Bulletin (Datawrapper) CSV parsing
src/lib/rss.js       regex RSS parser, merge/dedupe
src/lib/render.js    server-side HTML for every section + template fill
public/index.html    template ({{placeholders}} filled by the Worker on every request)
public/style.css, public/app.js, public/portrait.jpg, public/portrait-full.jpg
test/*.test.js       node --test, fixtures in test/fixtures/
```

## Data flow

* Cron `*/10 * * * *`: Kalshi batch (1 call) + Polymarket keyset (1) + two 2028 slugs + the
  rolling "out by month-end" event → `buildSnapshot()` → KV `snapshot`.
* Cron `5 * * * *` (hourly): also NYT + Silver Bulletin approval, the 2028 winner events
  (Kalshi `KXPRESPERSON-28`, Polymarket `presidential-election-winner-2028`), monthly-market
  discovery, and the four news feeds → KV `news`.
* `/` reads both KV keys, injects the snapshot into `public/index.html` (answer, countdown seed,
  headline odds, tables, approval, news, `<script id="state">`) and caches 60 s. Works without JS.
* `/api/state`, `/api/news`: JSON, CORS `*`, Cache API in front of KV. If KV is empty (cold start)
  the Worker refreshes inline so the page is never blank.
* Per-source `ok` flags; when an upstream fails, the previous good values are carried forward
  and the UI says so.

## Headline math

* **Chance it actually ends** = 1 − clamp(mean(Kalshi, Polymarket "Trump wins 2028") + (1 − Kalshi "2028 election occurs")).
* **Chance it ends early** = max (not sum) of Kalshi leaves-office / resigns / impeached-and-removed / 25th Amendment.
* Thin markets (Kalshi spread > 0.05; Polymarket liquidity ≤ $5k or spread ≥ 0.05) are ignored when a solid venue exists.
* No market prices death; the page says so.

## Flip the answer

The answer flips to **YES** automatically when the term-end date passes, when Kalshi
`KXTRUMPOUT27-27-JAN2029` / `KXTRUMPREMOVE` / `KXTRUMPRESIGN` settles YES, or when Polymarket
`trump-out-as-president-before-2027` (or the current monthly market) resolves YES.

To flip it by hand: set `"override": "YES"` (or `"NO"`) in `config.json` and push.
A quicker switch without a deploy: `npx wrangler kv key put --binding STATE override YES`
(`config.json` wins over KV, which wins over the computed answer).

## Develop

```bash
npm install
npm run dev        # http://localhost:8787
npm test           # node --test test/
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=5+*+*+*+*"   # run the hourly cron locally
```

## Deploy

Pushes to `main` auto-deploy via Cloudflare Workers Builds (`npx wrangler deploy`).
Manual: `npm run deploy`.

## Credits

Portrait: Official White House portrait, June 2025 (photo: Daniel Torok) — public domain, 17 U.S.C. § 105.
Odds: Kalshi, Polymarket · Approval: NYT polling average, Silver Bulletin · News: Google News, The Guardian, Politico, The Hill.
