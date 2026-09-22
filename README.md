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
src/lib/kalshiAuth.js optional Kalshi API-key request signing (inert without the secrets; see "Kalshi and 429s")
src/lib/render.js    server-side HTML for every section + template fill
.github/workflows/kalshi.yml  optional Kalshi relay (GitHub runner → KV `kalshi`); workflow_dispatch only until enabled
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
  and the UI says so. A 200 that omits a few expected markets is flagged `partial` with the missing ids,
  and each omitted market keeps its last good row (`carried: true`, with the time it was really fetched,
  listed in `sources.<venue>.carried`) so one missing ticker cannot move the headline. There is no
  staleness cap on carried rows — the section warning with its timestamp is the signal.
* Kalshi settled markets price at their payout (`result` "yes" → 100%, "no" → 0%), never at the last
  trade, so a finalized `KXPRESELECTIONOCCUR-28` feeds `p_noelect = 0` exactly.

## Headline math

* **Chance it actually ends** = 1 − clamp(mean(Kalshi, Polymarket "Trump wins 2028") + (1 − Kalshi "2028 election occurs")).
* In the odds tables a question priced on both venues is ONE row: Yes = the same cross-venue mean the
  headline uses, with each venue's own price in the Venue cell (2028 candidates are matched by name across
  venues — "J.D. Vance" / "JD Vance" — from 20-deep lists per venue, then cut to the top 8).
* **Chance it ends early** = max (not sum) of Kalshi leaves-office / resigns / impeached-and-removed / 25th Amendment.
* Thin markets (Kalshi spread > 0.05; Polymarket liquidity ≤ $5k or spread ≥ 0.05) are ignored when a solid venue exists.
* No market prices death; the page says so.

## Flip the answer

The answer flips to **YES** automatically when the term-end date passes, when Kalshi
`KXTRUMPOUT27-27-JAN2029` / `KXTRUMPREMOVE` / `KXTRUMPRESIGN` settles YES, or when Polymarket
`trump-out-as-president-before-2027` (or the current monthly market) resolves YES.

Caveat on the umbrella market: Kalshi's `KXTRUMPOUT27-27-JAN2029` also pays out on an **announced**
departure within a year, so it can settle YES while he is still in office. A YES from that market alone
is shown as YES with `confirmed: false` and no `endedAt`: the page keeps the live countdown and the banner
says the market "also pays out on an announced departure". The first act-based trigger (`KXTRUMPRESIGN` /
`KXTRUMPREMOVE` settled, a Polymarket exit market resolved, or the term end) confirms it and supplies the
"It ended <date>" (Kalshi's `updated_time` of the settled market, else the cron time); that first
confirmed date then sticks. If an announcement is retracted, set the override to `NO`.

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

## Kalshi and 429s

Kalshi rate-limits anonymous traffic per source IP, and Cloudflare Workers share their egress IPs with
thousands of other tenants. Probed from the edge (2026-09-22, every User-Agent): the **list** endpoints
(`/markets?tickers=…`, `/markets?event_ticker=…`) answer HTTP 429 `too_many_requests`, while the
**single-market** endpoint (`/markets/{ticker}`) and the **event** endpoint
(`/events/{ticker}?with_nested_markets=true`) answer 200 from the same edge. So the Worker tries, in order:

1. the 18-ticker batch (1 subrequest — works from anywhere that is not a shared edge IP);
2. one request per ticker in parallel (18 subrequests, no retries) → `sources.kalshi.via = "singles"`;
3. the KV relay document (below) if younger than 45 minutes → `via = "relay"`;
4. the previous good map, row by row (`sources.kalshi.ok = false`, rows marked `carried`).

The 2028 election leg does the same: list → event endpoint → relay. In production step 2 is what runs.
If Kalshi ever throttles the single-market endpoint too, two credential routes are already wired up and
inert until configured — pick ONE:

**A. Kalshi API key (signed requests; limits become per-key).** Unverified whether a key bypasses the
IP-level 429 — confirm with one deploy before relying on it.

```bash
# kalshi.com → Account → API keys → create; it downloads a PKCS#1 PEM. WebCrypto needs PKCS#8:
openssl pkcs8 -topk8 -nocrypt -in kalshi.pem -out kalshi.pk8
npx wrangler secret put KALSHI_KEY_ID          # paste the key id
npx wrangler secret put KALSHI_PRIVATE_KEY < kalshi.pk8
```

`src/lib/kalshiAuth.js` then signs every Kalshi request (RSA-PSS/SHA-256 over
`timestamp + METHOD + path`, headers `KALSHI-ACCESS-KEY/-TIMESTAMP/-SIGNATURE`). Without both secrets
requests stay keyless, so `wrangler dev` and the tests are unchanged.

**B. Relay from a different egress (GitHub Actions → KV).** `.github/workflows/kalshi.yml` fetches the
18-ticker batch and the `KXPRESPERSON-28` list from a GitHub runner and PUTs
`{ fetchedAt, batch, election2028 }` to KV key `kalshi`.

1. Cloudflare dashboard → My Profile → API Tokens → Create Token → permission **Workers KV Storage: Edit**
   scoped to this account only. GitHub repo → Settings → Secrets → Actions: `CF_KV_TOKEN` = that token,
   `CF_ACCOUNT_ID` = the account id (dashboard → Workers & Pages → overview, right column).
2. Run the workflow once by hand (Actions → "Kalshi relay" → Run workflow) and check the job log says the
   Kalshi calls returned 200.
3. Uncomment the `schedule:` block in the workflow (this repo is public, so Actions minutes are free).

Verify after any change across two cron ticks with `/api/state`: `sources.kalshi.ok === true`,
`markets.kalshi` has 18 keys, `ends.venues == ["Kalshi","Polymarket"]` with `ends.pct` ≈ 89–90,
`early.pct` non-null, `election2028.kalshi` non-null; the page shows kalshi.com links and no
"(Polymarket only)" tag.

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
