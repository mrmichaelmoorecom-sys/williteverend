# williteverend.com — DATA SOURCES & IMPLEMENTATION SPEC

Synthesized 2026-09-22 ~06:30 UTC from five research reports + five independent verification passes (all endpoints below were re-fetched with curl at 06:21–06:30 UTC by the synthesizer; values are live prices and move constantly). Where a report and its verification disagreed, the verification wins. Term end used everywhere: `2029-01-20T17:00:00Z` (noon ET). Days left (from 2026-09-22) = 851; days to 2027-01-01 = 101.

Architecture assumed: one Cloudflare Worker (static assets in `/public`, `fetch` handler for `/api/*`, `scheduled` cron that pulls every upstream server-side, writes one JSON snapshot to KV, and the browser reads only `/api/snapshot` + `/api/news`). Nothing below needs an API key.

---

## 0. TL;DR of the current numbers (2026-09-22 06:2x UTC)

| Thing | Value | Source |
|---|---|---|
| Leaves office before Jan 20 2029 (excl. death) | **23.5%** (bid 0.23 / ask 0.24) | Kalshi `KXTRUMPOUT27-27-JAN2029` |
| Leaves before 2028 / before 2027 | 16.5% / 4.05% | Kalshi `KXTRUMPOUT27-27-28` / `-DJT` |
| Out as President before 2027 | 5.5% | Polymarket `trump-out-as-president-before-2027` |
| Out by Sep 30 2026 | 0.15% | Polymarket `dtrump-out-as-president-by-september-30` |
| Resigns before term ends | 23.5% | Kalshi `KXTRUMPRESIGN` |
| Impeached AND removed | 17% | Kalshi `KXTRUMPREMOVE` |
| 25th Amendment used before 2029 | 16% | Kalshi `KXAMEND25-29` |
| Impeached (House vote) before Jan 20 2029 | 65% / 68.5% | Kalshi `KXIMPEACH-29-JAN20` / Polymarket `will-trump-be-impeached-before-his-term-ends` |
| Wins 2028 election ("third term") | 2.7% / 1.45% | Kalshi `KXPRESPERSON-28-DTRU` / Polymarket `will-donald-trump-win-the-2028-us-presidential-election` |
| 2028 election does NOT occur | 8.3% | 1 − Kalshi `KXPRESELECTIONOCCUR-28` (0.906/0.928) |
| Approval (NYT avg 2026-09-22) | 37.8 / 59.3 | NYT CSV |
| Approval (Silver Bulletin 9/21/2026) | 38.60 / 58.86 | Datawrapper kSCt4 v7832 |
| Approval (RCP avg 9/2–9/20) | 40.1 / 58.6 | RCP HTML (fragile) |
| Approval dips below 37% in 2026 | 73.5% | Kalshi `KXTRUMPAPPROVALBELOW-26DEC31-37` |
| Health / death market | **none exists** on Kalshi or Polymarket (Kalshi KXTRUMPOUT27 explicitly excludes death) | — |

Headline derived numbers (formulas in §1.5/§1.6): **ENDS-ON-OR-BEFORE-SCHEDULE = 89.6%**, **ENDS EARLY = 23.5%**, hazard-extrapolated early exit from Polymarket ≈ 37.9% (model output, label as such).

---

## 1. ODDS

### 1.0 Venue mechanics (read first)

**Kalshi** — base `https://api.elections.kalshi.com/trade-api/v2`, keyless.
- Prices are DOLLAR STRINGS: `yes_bid_dollars`, `yes_ask_dollars`, `last_price_dollars`, `no_bid_dollars`, `no_ask_dollars`, `previous_price_dollars` (e.g. `"0.2400"` = 24%). Legacy integer fields (`yes_bid`, `last_price`) are ABSENT/null. Volume = `volume_fp` (string), `volume_24h_fp`, `open_interest_fp`. Other fields: `ticker`, `event_ticker`, `title`, `yes_sub_title`, `no_sub_title`, `close_time`, `status` (`"active"` while open, `"finalized"` when settled), `result` (`""` while open, `"yes"`/`"no"` when settled), `rules_primary`, `rules_secondary`, `strike_type` (`less|between|greater`), `floor_strike`, `cap_strike`, `expiration_value`.
- `prob = (parseFloat(yes_bid_dollars)+parseFloat(yes_ask_dollars))/2`, fallback `parseFloat(last_price_dollars)`. Flag `thin` if `ask−bid > 0.05` (e.g. `KXTRUMPRUN-28NOV07` 0.14/0.22).
- List endpoint returns `{"cursor":"","markets":[...]}`; single `/markets/{ticker}` returns `{"market":{...}}`.
- **CORS: HTTP 403 for ANY request carrying an `Origin` header other than `https://kalshi.com`** (verified again: no Origin → 200; `Origin: https://williteverend.com` → 403). Worker `fetch()` sends no Origin, so it works server-side; NEVER forward the browser's Origin. `cache-control: public, max-age=15`.
- No embed/iframe exists (kalshi.com sends `content-security-policy: frame-ancestors 'self' *.kalshi.com *.kalshi.co`; kalshi.com HTML returns 429 to curl). Link out with `https://kalshi.com/markets/<series_ticker_lower>/x/<event_ticker_lower>` (any slug segment redirects to canonical), e.g. `https://kalshi.com/markets/kxtrumpout27/x/kxtrumpout27-27`.
- Never call `/series` at runtime (17 MB, limit ignored).

**Polymarket** — Gamma `https://gamma-api.polymarket.com`, CLOB `https://clob.polymarket.com`, Data API `https://data-api.polymarket.com`, keyless.
- USE ONLY NON-DEPRECATED ROUTES: `/events/slug/<event-slug>` (object), `/markets/slug/<market-slug>` (object), `/events/<id>`, `/markets/<id>`, `/events/keyset?...`. The list-style `/events?slug=...`, `/events?tag_slug=...`, `/markets?slug=...` return `deprecation: true`, `sunset: Fri, 01 May 2026` (already past), `warning: 299 - "use /events/keyset"` — they still answer today but may vanish.
- Gamma market fields: `outcomePrices` is a JSON-ENCODED STRING (`"[\"0.055\", \"0.945\"]"` → `JSON.parse` → index 0 = Yes), likewise `outcomes` and `clobTokenIds`. `lastTradePrice` (number|null), `bestBid`, `bestAsk`, `spread`, `volume` (string|null on markets, number on events), `liquidity` (string|null), `endDate`, `closed`, `active`, `conditionId`, `question`, `groupItemTitle`, `slug`, `id`.
- `p_yes = parseFloat(JSON.parse(m.outcomePrices)[0])`; fallback `m.lastTradePrice`. Trust only when `parseFloat(m.liquidity) > 5000 && (m.bestAsk − m.bestBid) < 0.05`, else `thin` (e.g. `will-trump-be-impeached-by-december-31-2027` shows 0.705 with bid 0.52/ask 0.89, vol $825 — meaningless).
- CORS: `access-control-allow-origin: *` on Gamma AND every CLOB route, but only when the request carries an `Origin` header (browsers always do). `data-api` sends `*` unconditionally. Gamma `cache-control: public, max-age=300`; data-api `max-age=90`.
- Rate limits (docs): Gamma /events 500 req/10s, /markets 300/10s, /public-search 350/10s; CLOB 15,000/10s; data-api /v2/prices-history 200/10s.
- Embeds work: `<iframe src="https://embed.polymarket.com/market?market=<MARKET-slug>&theme=dark&buttons=false" width="400" height="400" frameborder="0">` — embed host sends NO x-frame-options / frame-ancestors. Event rotation: `?event=<event-slug>&rotate=true`. Extra params: `volume=false chart=false liveactivity=true yaxis=false grid=false border=true banner=true fit=true width=N height=N`. WARNING: embed returns HTTP 200 with a "Market not found" body for bogus slugs — validate slugs via Gamma first. Never iframe polymarket.com itself (frame-ancestors 'self').
- Polymarket markets are `restricted: true` for US users — display only.

### 1.1 ONE-CALL FETCH LIST (cron)

**Kalshi (1 request):**
```
GET https://api.elections.kalshi.com/trade-api/v2/markets?tickers=KXTRUMPOUT27-27-JAN2029,KXTRUMPOUT27-27-28,KXTRUMPOUT27-27-DJT,KXTRUMPREMOVE,KXTRUMPRESIGN,KXIMPEACH-29-JAN20,KXIMPEACH-28-JAN01,KXAMEND25-29,KXPRESPERSON-28-DTRU,KXPRESNOMR-28-DJT,KXTRUMPRUN-28NOV07,KXPRESELECTIONOCCUR-28,KXPRESPARTY-2028-D,KXPRESPARTY-2028-R,KXMARTIAL-29JAN20,KXINSURRECTION-29
```
Verified 200, 16 markets, all `status:"active"`, `result:""`. Field path: `markets[i].yes_bid_dollars` etc.; key by `markets[i].ticker`.

**Polymarket (1 request, 86,800 bytes, non-deprecated):**
```
GET https://gamma-api.polymarket.com/events/keyset?slug=trump-out-as-president-before-2027&slug=dtrump-out-as-president-by-september-30&slug=will-trump-be-impeached-by-december-31-2026&slug=will-trump-resign-by-december-31-2026&slug=trump-removed-via-25th-amendment-before-2027&slug=how-low-will-trumps-approval-rating-go-in-2026&slug=will-trump-be-impeached-before-his-term-ends&slug=will-trump-repeal-presidential-term-limits-in-2026
```
Verified 200 → `{"$schema":..., "events":[8 events with full markets[]]}` (`next_cursor` absent/null). Key markets by `events[i].markets[j].slug`. Note `dtrump-out-as-president-by-september-30` ends `2026-10-01T03:59:00Z` — replace via discovery (§1.1.1).

**Polymarket 2028 lines (2 small requests, non-deprecated):**
```
GET https://gamma-api.polymarket.com/markets/slug/will-donald-trump-win-the-2028-us-presidential-election
GET https://gamma-api.polymarket.com/markets/slug/will-donald-trump-win-the-2028-republican-presidential-nomination
```
Verified 200 (objects). id `561243` yes 0.0145 (bid 0.011/ask 0.018, liq $666,710, vol $10.57M, clobTokenIds[0]=`11807691644868166983390207408868795383945915035851758101409310535538572683733`); id `561973` yes 0.0205 (bid 0.02/ask 0.021, liq $371,524, vol $9.58M).

#### 1.1.1 Auto-discover the rolling Polymarket "out by <month-end>" market
Slug format is unpredictable (`dtrump-...` leading d because a closed 2025 event owns the plain slug; others have timestamp suffixes). Do NOT hardcode.
```
GET https://gamma-api.polymarket.com/events/keyset?title_search=out%20as%20president&closed=false&include_markets=false&limit=50&order=volume&ascending=false
```
Verified 200 (15 events; includes putin/sheinbaum/etc). Filter: `e.slug` matches `/^d?trump-out-as-president/` AND `new Date(e.endDate) > now`; pick the earliest `endDate` for "this month", and `trump-out-as-president-before-2027` (id 73969) for "this year". Then `GET https://gamma-api.polymarket.com/events/slug/<slug>` for its `markets[0]`. As of today NO October successor exists → tolerate an empty "this month" slot after 2026-10-01T03:59Z. Exclude `natalie-harp-out-as-special-assistant-to-the-president-by-december-31` (matches the title search, fails the slug regex).

### 1.2 Group 1 — LEAVES OFFICE EARLY (impeachment / removal / resignation / health)

| Label | Venue | Identifier (verbatim) | Field path | Current | Units / notes |
|---|---|---|---|---|---|
| Leaves office before Jan 20 2029 | Kalshi | `KXTRUMPOUT27-27-JAN2029` (event `KXTRUMPOUT27-27`, series `KXTRUMPOUT27`) | `yes_bid_dollars`/`yes_ask_dollars` | 0.2300/0.2400, last 0.2400, vol_fp 566837.81, close 2029-01-20T15:00:00Z | **PRIMARY early-exit market.** `rules_primary`: "If Donald Trump leaves office before January 20, 2029, then the market resolves to Yes." `rules_secondary`: death → settles at last traded price (NOT Yes); an announcement he will leave within a year also counts. Event title "Donald Trump announces departure as President? (Excluding death)". |
| Leaves before 2028 | Kalshi | `KXTRUMPOUT27-27-28` | same | 0.1600/0.1700, vol 903228.99, close 2028-01-01T15:00:00Z | |
| Leaves before 2027 | Kalshi | `KXTRUMPOUT27-27-DJT` | same | 0.0400/0.0410, vol 5976411.95, close 2027-01-01T15:00:00Z | |
| Resigns before term ends | Kalshi | `KXTRUMPRESIGN` (series=event=market) | same | 0.2300/0.2400, vol 433407.83, close 2029-01-21T15:00:00Z | |
| Impeached AND removed | Kalshi | `KXTRUMPREMOVE` (series=event=market) | same | 0.1600/0.1800, last 0.1800, vol 686527.04, close 2029-01-20T15:00:00Z | only Kalshi impeachment market that implies the term ending |
| 25th Amendment used before 2029 | Kalshi | `KXAMEND25-29` (series `KXAMEND25`) | same | 0.1500/0.1700, vol 186652.92 | closest thing to a health/incapacity market; a temporary §3 transfer also resolves Yes → do NOT use for the YES flip |
| Impeached (House) before Jan 20 2029 | Kalshi | `KXIMPEACH-29-JAN20` (event `KXIMPEACH-29`) | same | 0.6400/0.6600, vol 574166.10 | impeachment ≠ removal; display only |
| Impeached before Jan 1 2028 | Kalshi | `KXIMPEACH-28-JAN01` (event `KXIMPEACH`) | same | 0.6500/0.6600, vol 1127277.09 | |
| Out as President before 2027 | Polymarket | event `trump-out-as-president-before-2027` id 73969 / market id 666861 / conditionId `0x48b0b0bca515f68fccf95af4793dbd0edbfec1f8ec6e8df2c0f69ba74f8c4722` / Yes token `59252515735652674747158950210016502214756531287333895140318848923768750410355` | `events[].markets[0].outcomePrices[0]` | 0.055 (bid 0.05/ask 0.06, liq $344,596, vol $11.82M, end 2027-01-01T04:59:00Z) | resolution: resigns/removed/ceases to be President for any period before end date; temporary 25th §3 doesn't count. Direct: `https://gamma-api.polymarket.com/events/slug/trump-out-as-president-before-2027` |
| Out by Sep 30 2026 (rolls monthly) | Polymarket | event `dtrump-out-as-president-by-september-30` id 956176 / market 4174612 / cond `0xc3794a8d3a34d04b9f39773e35c4cecdac89d32eab93e8589d9a6f03e04e9490` | same | 0.0015 (bid 0.001/ask 0.002, vol $1.63M, end 2026-10-01T03:59:00Z) | discover via §1.1.1 |
| Resigns by Dec 31 2026 | Polymarket | `will-trump-resign-by-december-31-2026` id 568117 / cond `0x448f73e89890ae9d0e42ad0b592f63b53c0ae05d1ca3fa8d80b30027781f1be7` | same | 0.0305 (bid 0.03/ask 0.031, liq $54,654, vol $540,864) | |
| Removed via 25th before 2027 | Polymarket | `trump-removed-via-25th-amendment-before-2027` id 665449 / cond `0x57daa520ae47dc77352fe7387adf820c4ab58d46d9ffb814849ef5e672e1322a` | same | 0.0315 (bid 0.029/ask 0.034, liq $34,051, vol $50,812, `volume24hr` null) | |
| Impeached by Dec 31 2026 | Polymarket | market `will-trump-be-impeached-by-december-31-2026` id 568116 / cond `0x4c8ceef9b9c0a27b6b4efa7c398ece4a5eeda76502f722de398c232abefe2ede` (inside event of same slug, id 34348 — use ONLY the markets[] entry whose slug matches; sibling markets 4595915/4595916 are thin/null) | same | 0.0205 (bid 0.02/ask 0.021, liq $102,626, vol $1.03M) | |
| Impeached before term ends | Polymarket | `will-trump-be-impeached-before-his-term-ends` id 1643703 / event 284199 / cond `0x553a941e8a11cac22eb746b6bbea0530695ee3e1b0693d80433d7b943c91cab7` | `outcomePrices[0]` | 0.685 (bid 0.67/ask 0.70, liq $19,401, vol $103,095, end **2029-01-20T17:00:00Z**) | only Polymarket market whose endDate is the term end; House vote ≠ removal |
| Health / death / incapacitation | — | **NONE** (18,651 open Polymarket events and 14,248 Kalshi series swept: zero) | | | "odds of dying" cannot be sourced from a market; use the 25th-Amendment rows and say so |

Bonus colour (Kalshi): `KXMARTIAL-29JAN20` martial law before term ends 0.3400/0.3500; `KXINSURRECTION-29` Insurrection Act before Jan 20 2029 0.4400/0.4500; `KXMOCTRUMP25-26-JAN01` GOP member of Congress calls for 25th before 2027 ~0.08/0.11.

### 1.3 Group 2 — STAYS PAST JAN 20 2029 / THIRD TERM

No literal "still president after Jan 20 2029" or "third term" market exists on either venue (Kalshi series `KX3RDTERM` has zero markets; Polymarket full keyset sweep negative). Proxies:

| Label | Venue | Identifier | Current | Notes |
|---|---|---|---|---|
| Trump wins 2028 election | Kalshi | `KXPRESPERSON-28-DTRU` (event `KXPRESPERSON-28`, `yes_sub_title` "Donald J. Trump") | 0.0260/0.0280, last 0.0250, vol 3625017.49, close 2029-11-07T15:00:00Z | |
| Trump wins 2028 election | Polymarket | `will-donald-trump-win-the-2028-us-presidential-election` id 561243 | 0.0145 (bid 0.011/ask 0.018) | |
| 2028 election occurs | Kalshi | `KXPRESELECTIONOCCUR-28` | 0.9060/0.9280 → **not-occur = 0.083** | close 2028-12-01T04:59:00Z; longshot floor inflates this |
| Trump is 2028 GOP nominee | Kalshi / Polymarket | `KXPRESNOMR-28-DJT` / `will-donald-trump-win-the-2028-republican-presidential-nomination` id 561973 | 0.0230/0.0260 / 0.0205 | |
| Announces 2028 run before Nov 7 2028 | Kalshi | `KXTRUMPRUN-28NOV07` (series `KXTRUMPRUN`, whose catalog title is literally "Trump run for a third term") | 0.1400/0.2200 (thin) | present as Kalshi's own third-term-labelled market |
| Repeals presidential term limits in 2026 | Polymarket | `will-trump-repeal-presidential-term-limits-in-2026` id 1321903 (event 196931) | 0.023 (bid 0.018/ask 0.028, liq $17,366, vol $14,102) | |
| Trump family member is 2028 GOP nominee | Kalshi | `KXTRUMPPRES-28` | 0.0780/0.0910 | optional |

### 1.4 Group 3 — APPROVAL (market view; the actual number comes from §2)

| Label | Venue | Identifier | Current | Notes |
|---|---|---|---|---|
| Approval below 37% at any point in 2026 (VoteHub) | Kalshi | `KXTRUMPAPPROVALBELOW-26DEC31-37` (siblings `-36` 0.42/0.45, `-35` 0.25/0.26, `-34` 0.13/0.14, `-33` 0.091/0.096; close 2027-01-07T12:00:00Z) | 0.7200/0.7500 | good "how low will it go" stat |
| Approval above 43% at any point in 2026 | Kalshi | `KXTRUMPAPPROVALYEAR-26DEC31-43` (…-44..-50) | 0.0760/0.0850 | |
| Daily RCP-average bins (rolls daily) | Kalshi | series `KXTRUMPAPPROVE`; today's event `KXTRUMPAPPROVE-26SEP22` (markets `-U39.9`, `-E39.9`, `-E40.0`…`-E40.5`, `-A40.5`; `strike_type` less/between/greater with `cap_strike`/`floor_strike`) | Below 39.9: 0.69/0.70 | discover with `GET https://api.elections.kalshi.com/trade-api/v2/events?series_ticker=KXTRUMPAPPROVE&status=open&limit=1` → `events[0].event_ticker` (verified: `KXTRUMPAPPROVE-26SEP22`, strike_date 2026-09-22T17:00:00Z) then `GET /markets?event_ticker=<that>&status=open`. Market-implied RCP = Σ(bin-midpoint × bin-prob) with midpoints: less→`cap_strike−0.05`, between→`floor_strike`, greater→`floor_strike+0.05`. |
| Weekly RCP bins (rolls weekly) | Kalshi | series `KXAPRPOTUS`; current event `KXAPRPOTUS-26SEP25` (8 markets, ~107K vol, resolves on RealClearPolitics 11 AM ET) | implied ~39.4–39.9 | same discovery pattern (`series_ticker=KXAPRPOTUS`) |
| Approval hits 35% in 2026 (Silver Bulletin) | Polymarket | `will-trumps-approval-rating-hit-35-in-2026` id 665369 (event `how-low-will-trumps-approval-rating-go-in-2026` id 73128; `hit-40` id 665368 already resolved Yes; `hit-30` id 665370 0.06; ignore `hit-37/36/34` vol 0, `hit-20` thin) | 0.265 (bid 0.26/ask 0.27, liq $10,072, vol $103,807) | |

### 1.5 Group 4 — 2028 ELECTION / NORMAL TRANSFER

- Kalshi: `GET https://api.elections.kalshi.com/trade-api/v2/markets?event_ticker=KXPRESPERSON-28&status=open&limit=200` → 30 markets, label = `yes_sub_title`, sort by `yes_bid_dollars` desc. Current top: `KXPRESPERSON-28-JVAN` 0.21/0.22, `-JOSS` 0.11/0.12, `-MRUB` 0.096/0.097, `-AOCA` 0.092/0.093, `-GNEWS` 0.075/0.078, `-KHAR` 0.038/0.041, `-DTRU` 0.026/0.028. Party: `KXPRESPARTY-2028-D` 0.5800/0.5900, `KXPRESPARTY-2028-R` 0.4100/0.4200 (filter `event_ticker==KXPRESPARTY-2028`; 2032 markets exist in the same series). Link: `https://kalshi.com/markets/kxpresperson/x/kxpresperson-28`.
- Polymarket: `GET https://gamma-api.polymarket.com/events/slug/presidential-election-winner-2028` (event id 31552, negRisk, ~445 KB, 128 markets, vol $708M) — fetch in the hourly cron only. **76 of 128 markets have NO `outcomePrices` key** (placeholders, `active:false`) → filter `m.active && m.outcomePrices` before parsing; display `m.groupItemTitle` or `m.question`, NEVER derive names from slug (`will-person-ad-win-...` is Mark Kelly). Top: Vance 0.2065, AOC 0.1335, Ossoff 0.1155, Rubio 0.0755, Newsom 0.0685, Harris 0.0465, Shapiro 0.0305, Buttigieg 0.0265, Trump 0.0145. Embed: `https://embed.polymarket.com/market?event=presidential-election-winner-2028&rotate=true`.

### 1.6 HEADLINE FORMULA — "chance it actually ends" (on or before Jan 20 2029)

```
k_win2028   = mid(KXPRESPERSON-28-DTRU)                 // 0.027
pm_win2028  = yes(will-donald-trump-win-the-2028-us-presidential-election)   // 0.0145
p_win2028   = mean(available of k_win2028, pm_win2028)  // 0.02075
p_noelect   = 1 - mid(KXPRESELECTIONOCCUR-28)           // 0.083   (Kalshi only; no Polymarket equivalent)
P_STAYS     = clamp(p_win2028 + p_noelect, 0, 1)        // 0.10375  (treated as disjoint: no election ⇒ no win)
ENDS        = 1 - P_STAYS                               // 0.896  → display "89.6%"
```
- Averaging rule: whenever both venues have the same question, `mean()` of the two mids; if one venue is down/thin, use the other alone and set `snapshot.sources.<venue>.ok=false` so the UI can show a "(Kalshi only)" tag.
- Fallbacks: Kalshi down → `P_STAYS = pm_win2028` (0.0145 → ENDS 98.6%). Polymarket down → `P_STAYS = k_win2028 + p_noelect` (0.11 → 89.0%). Both down → serve the last-good KV snapshot with its `updatedAt`; if KV empty, render headline as "—" and keep the day counter (pure client math).
- Display with one decimal; recompute only in the cron so all viewers see the same number.

### 1.7 "ENDS EARLY" probability (before Jan 20 2029)

```
P_EARLY = max( mid(KXTRUMPOUT27-27-JAN2029),  // 0.235  umbrella market
               mid(KXTRUMPRESIGN),             // 0.235  nested inside the umbrella
               mid(KXTRUMPREMOVE),             // 0.17   nested
               mid(KXAMEND25-29) )             // 0.16   nested (and over-inclusive)
        = 0.235
```
- Overlap: resignation, removal and 25th are all sub-cases of "leaves office", so NEVER sum them — take the max (the umbrella should already be ≥ each component; max only guards a mispriced leg).
- Polymarket has no full-term early-exit market. Cross-check row "before 2027": `mean(pm 0.055, KXTRUMPOUT27-27-DJT 0.0405) = 0.048`. Optional model row: hazard extrapolation `1 - (1 - 0.055)^(851/101) = 0.379` — label "extrapolated from the before-2027 market; long-dated longshots carry a price floor; seeding with the Sep-30 market instead gives 13%". Never put the extrapolation in the headline.
- Death caveat: KXTRUMPOUT27 excludes death; nothing prices it. Say so in the UI.

### 1.8 NO → YES flip rule (banner)

Banner shows **YES** when ANY of:
1. `now >= 2029-01-20T17:00:00Z` (term ended on schedule) unless KV `override == "NO"`.
2. Kalshi `KXTRUMPOUT27-27-JAN2029`: `status == "finalized" && result == "yes"` (proof of shape: sibling `KXTRUMPOUT27-27-26AUG01` is `status "finalized", result "no", expiration_value "No"`). Same test on `KXTRUMPREMOVE`, `KXTRUMPRESIGN`. (Do NOT include `KXAMEND25-29`, `KXIMPEACH-*`.)
3. Polymarket `trump-out-as-president-before-2027` or the current monthly `…out-as-president-by-…` market: `closed == true && JSON.parse(outcomePrices)[0] == "1"` (shape proof: `will-trumps-approval-rating-hit-40-in-2026` is `closed:true, outcomePrices ["1","0"]`).
4. KV `override == "YES"` (manual switch for death or anything markets miss; set with `npx wrangler kv key put --binding STATE override YES --remote` (wrangler 4 defaults kv commands to --local; un-flip with `kv key delete ... --remote`, not `put ... NO`)).
Otherwise **NO**. Optional sub-line without flipping: if `P_EARLY >= 0.5` or any Group-1 market mid ≥ 0.5 show "markets now expect an early exit". Cron every 10 min is fast enough; settled markets keep answering the same API.

### 1.9 Optional live/sparkline endpoints
- Browser-side live tick (CORS * with Origin): `https://clob.polymarket.com/midpoint?token_id=59252515735652674747158950210016502214756531287333895140318848923768750410355` → `{"mid":"0.055"}`; `/price?token_id=&side=buy|sell` → `{"price":"0.05"}`; `/spread` → `{"spread":"0.01"}`; `/book` → bids ASCENDING / asks DESCENDING (best = last element of each).
- Sparkline (preferred, replaces CLOB route per Sep 4 2026 changelog): `https://data-api.polymarket.com/v2/prices-history?token_id=<yesTokenId>&interval=1w&bucket_seconds=3600` → `{"data":[{"timestamp":1789452000,"price":0.055,"resolution_seconds":3600},…],"pagination":{…}}` (170 pts; last point `resolution_seconds:0` = live tick; `interval=max` → 602 pts back to 2025-11-06 when the market opened at 0.125). ACAO * unconditional, max-age=90.
- Kalshi candles: `https://api.elections.kalshi.com/trade-api/v2/series/KXTRUMPOUT27/markets/KXTRUMPOUT27-27-JAN2029/candlesticks?start_ts=<now-30d unix s>&end_ts=<now unix s>&period_interval=1440` → `candlesticks[].end_period_ts`, `.price.close_dollars`, `.yes_bid.close_dollars`, `.yes_ask.close_dollars`, `.volume_fp`. MUST compute timestamps at runtime (market created 2026-01-12; stale timestamps return `{"candlesticks":[]}`). 30-day closes ranged 0.19–0.26.

---

## 2. APPROVAL

Cron every 30–60 min (both primaries update at most a few times/day). Headline `approve = round1(mean(nyt, sb))`, same for `disapprove`, `net = approve − disapprove`. Current: (37.8+38.59664)/2 = **38.2**, (59.3+58.8613)/2 = **59.1**, net **−20.9**. Show both source values + dates with links ("NYT polling average", "Silver Bulletin"). Reject a primary if non-200, parse error, or latest date > 7 days old.

**PRIMARY A — NYT**
`GET https://www.nytimes.com/newsgraphics/polls/approval/president-averages.csv` (send a browser UA). Verified 200, ACAO `*`, `cache-control: public, max-age=300`, last-modified 2026-09-22 06:00:40 GMT. Long CSV, header exactly `topic,date,answer,pct`, 1208 data rows, two rows per date. Parse: filter `topic === "2025 Approval - Trump"`, `date` is ISO `YYYY-MM-DD`; take max date; `approve = pct where answer==="Approve"`, `disapprove = pct where answer==="Disapprove"`. Latest rows:
```
2025 Approval - Trump,2026-09-22,Approve,37.8
2025 Approval - Trump,2026-09-22,Disapprove,59.3
```
Companion raw-poll list (538 schema, ACAO *): `https://www.nytimes.com/newsgraphics/polls/approval/president.csv` (fields incl. `pollster,start_date,end_date,sample_size,population,yes,no`). Undocumented path — keep fallbacks.

**PRIMARY B — Silver Bulletin (Nate Silver) via Datawrapper chart `kSCt4`** — TWO STEPS EVERY REFRESH:
1. `GET https://datawrapper.dwcdn.net/kSCt4/` (245-byte HTML, `cache-control: max-age=1`) → body contains `<meta http-equiv="REFRESH" content="0; url=https://datawrapper.dwcdn.net/kSCt4/7832/">` → `version = /kSCt4\/(\d+)\//.exec(body)[1]` (currently `7832`). Pitfall: "kSCt4" itself contains a digit — capture the group, don't strip non-digits.
2. `GET https://datawrapper.dwcdn.net/kSCt4/${version}/dataset.csv` → verified 200, ACAO `*` (only with Origin header), `cache-control: public, max-age=31536000` (version-pinned, hence step 1), last-modified 2026-09-22 03:05:08 GMT (nightly ~11 PM ET). Header exactly `modeldate,approve,disapprove,approve_lo,approve_hi,disapprove_lo,disapprove_hi`, dates `M/D/YYYY`, ascending, 608 data rows → take LAST row:
```
9/21/2026,38.59664,58.8613,33.92469,43.2686,54.30453,63.41808
```
Chart page: `https://www.natesilver.net/p/trump-approval-ratings-nate-silver-bulletin`. This is the resolution source for Polymarket's weekly approval markets. Sibling charts (same two-step): `RFXsV` issue net approval (`modeldate,immg,econ,trade,cost`, dates M/D/YY), `AdipN` = IMMIGRATION approval only (do not confuse), `vknzT` = polls table (HTML in cells).

**FALLBACK 1 — Strength In Numbers (net only)**: resolver `https://datawrapper.dwcdn.net/z8nax/` → version `126` → `https://datawrapper.dwcdn.net/z8nax/126/dataset.csv`; header `Date,Overall,Civil rights/democracy,Deportations,Health care,Immigration,Inflation/cost of living,Jobs and the economy,Trade`; ISO dates; last row `2026-09-21,-24.750367166666656,…`. `Overall` is NET approval. CC BY-NC 4.0 (attribute; non-commercial).

**FALLBACK 2 — YouGov/Economist weekly tracker (single pollster, no CORS)**: `GET https://api-test.yougov.com/public-data/v5/us/trackers/donald-trump-approval/overall/` (trailing slash required; host really is api-test) → `{"raw_values":[[…Approve],[…Disapprove],[…Not sure]],"values":[…LOWESS-smoothed…]}`; `approve = values[0].at(-1)` (38.7), raw 39.7/57.8; dates from `https://api-test.yougov.com/public-data/v5/us/trackers/donald-trump-approval/details/` → `timestamps[]` ms epoch (last 1789344000000 = 2026-09-14), `tracker_type:"weekly"`.

**FALLBACK 3 — RealClearPolling (works, fragile)**: `GET https://www.realclearpolling.com/polls/approval/donald-trump/approval-rating` with headers `User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36` AND `Accept-Language: en-US,en;q=0.9` (both required; verified 200, 5.7 MB; without Accept-Language → 403 DataDome). Extract escaped JSON: regex `/\\"id\\":\\"8656\\",\\"type\\":\\"rcp_average\\".*?\\"spread\\":\{[^}]*\}\}/`, replace `\"`→`"`, parse → `candidate[{name:"Approve",value:"40.1"},{name:"Disapprove",value:"58.6"}]`, `date:"9/2 - 9/20"`. Poll id `8656`. Legacy `https://www.realclearpolitics.com/epolls/json/8656_historical.js` is frozen at 2026-02-25 — don't use. Fetch ≤ hourly, keep last-good.

**FALLBACK 4 — DDHQ (HTML scrape)**: `https://votes.decisiondeskhq.com/polls/presidential-approval/donald-j-trump-5/national/lv-rv-adults` (1.47 MB) → escaped `\"timeseries\":[{\"date\":\"2026-09-20Z\",\"data\":[{\"cand_id\":5,\"option_id\":3,\"value\":39,…},{\"option_id\":4,\"value\":59.6,…}]}]`; option_id 3 = Approve, 4 = Disapprove.

**FALLBACK 5 — FiftyPlusOne (HTML scrape; runs ~3 pts lower; robots blocks AI UAs)**: `https://fiftyplusone.news/polls/approval/president` → last inline literal `{end_date:"2026-09-21",…approve_estimate:35.5361578333,…disapprove_estimate:61.297166,…}` via `/\{end_date:"(\d{4}-\d{2}-\d{2})"[^}]*approve_estimate:([\d.]+)[^}]*disapprove_estimate:([\d.]+)[^}]*\}/g`.

DO NOT USE: VoteHub `https://api.votehub.com/polls?poll_type=approval&subject=Trump` (approval feed stale since 2026-08-31; no averages endpoint; 479 KB every call); FiveThirtyEight CSVs (302 → abcnews.go.com); Gallup (HTML only); economist.com (403).

Approval as an input to the headline: use `net` (−20.9) only as a displayed stat; it does not enter §1.6 (no defensible mapping from approval to term-ending probability; the markets already price it).

---

## 3. NEWS

All feeds are RSS 2.0 `<item>` lists; NONE of the on-topic ones send a usable ACAO (NYT/Fox/ABC do send `*`, NPR pins `https://apps.npr.org`) → proxy everything through the Worker; parse with regex (no DOMParser in Workers). Fetch with an explicit `User-Agent: Mozilla/5.0 (compatible; williteverend/1.0; +https://williteverend.com)` (The Hill returns 429 to the literal `curl/x.y` UA). Cache 5–10 min. Normalize to `[{title, link, source, pubDate (ISO), guid}]`, dedupe by normalized link then by lowercase title, sort desc, cap ~40.

**PRIMARY — Google News search RSS** (100 items, all publishers, no UA requirement, `cache-control: no-store`):
`https://news.google.com/rss/search?q=Trump+administration+when:2d&hl=en-US&gl=US&ceid=US:en` (drop `when:2d` for the full backlog; other verified queries: `q=%22White+House%22` 92 items, `q=Trump+impeachment+when:7d`, `q=Trump+%2225th+Amendment%22+when:7d`). Verified 200, 100 items, first pubDate Mon, 21 Sep 2026 20:43:44 GMT.
- `item.title` = `"Headline - Publisher"` → strip the trailing ` - <source text>` (use the `<source>` element to know the suffix). HTML entities present (`&apos;` `&#8217;` …) → decode.
- `item.link` = `https://news.google.com/rss/articles/<ID>?oc=5` redirect stub (302 → JS page; no publisher Location). Fine as `<a href target="_blank" rel="noopener">`; the viewer's browser lands on the publisher.
- `item.source` = `<source url="https://www.cnn.com">CNN</source>` → publisher name + homepage (favicon domain).
- `item.pubDate` RFC 822 GMT; `item.guid isPermaLink="false"` = the `<ID>`.
- Optional direct-link decode (undocumented RPC, works 6/6 today, has broken before; 2 requests per item; cache by `<ID>` in KV, try/catch, fall back to the stub): GET `https://news.google.com/articles/<ID>` with browser UA → regex `data-n-a-sg="…"` and `data-n-a-ts="…"`; POST `https://news.google.com/_/DotsSplashUi/data/batchexecute` form `f.req=[[["Fbv4je","<json of [\"garturlreq\",[[\"en-US\",\"US\",[\"FINANCE_TOP_INDICES\",\"WEB_TEST_1_0_0\"],null,null,1,1,\"US:en\",null,180,null,null,null,null,null,0,null,null,[1608992183,723341000]],\"en-US\",\"US\",1,[2,3,4,8],1,0,\"655456763\",0,0,null,0],\"<ID>\",<ts>,\"<sg>\"]>",null,"generic"]]]` → response contains `["garturlres","<real URL>"]`. Reference script: `(research scratch, not in repo) gnews_decode.py`. Never run per page-load.
- Google's feed copyright text says personal/non-commercial feed-reader use; keep the independent feeds below as the legally cleaner column.

**SECONDARY (independent, direct links, administration-specific) — merge all three:**
- The Guardian "Donald Trump" tag: `https://www.theguardian.com/us-news/donaldtrump/rss` — 200, 20 items, 17/20 on topic; first: "US TV networks suspend White House pool coverage over Trump media ban" → `https://www.theguardian.com/us-news/2026/sep/21/trump-tv-networks-white-house-pool-coverage`, pubDate `Tue, 22 Sep 2026 01:37:29 GMT`; fields `description, dc:creator, media:content, category`. Best on-topic conventional feed.
- Politico White House: `https://rss.politico.com/white-house.xml` — 200, 30 items, 227 KB (full `content:encoded`; extract only title/link/pubDate/description). pubDate uses zone ABBREVIATIONS (`Mon, 21 Sep 2026 18:00:00 EDT`) — V8 parses EDT/EST but normalize `EDT→-0400`, `EST→-0500` to be safe. `guid` = UUID. Hardcode source "Politico".
- The Hill Administration: `https://thehill.com/homenews/administration/feed/` — 200, 15 items, WordPress fields (`dc:creator` and `description` are CDATA; `guid` = `https://thehill.com/?p=<id>`; `enclosure` image; `dcterms:modified` ISO). pubDate `+0000`. NOTE `https://thehill.com/feed/` is a 301 → `https://thehill.com/feed/?feed=partnerfeed-news-feed&format=rss` (100 items, all sections); Workers `fetch` follows redirects by default.

**FALLBACKS (general politics; keyword-filter `/(Trump|White House|administration|president)/i`):** NYT Politics `https://rss.nytimes.com/services/xml/rss/nyt/Politics.xml` (20 items, ACAO *); Washington Post `https://feeds.washingtonpost.com/rss/politics` (20, 13 KB); NBC `https://feeds.nbcnews.com/nbcnews/public/politics` (25); NPR `https://feeds.npr.org/1014/rss.xml` (10, `-0400` offsets); BBC US&Canada `https://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml` (23, CDATA titles, tracking params `?at_medium=RSS&at_campaign=rss` on links, only ~5/23 on topic); Fox Politics `https://moxie.foxnews.com/google-publisher/politics.xml` (25, ACAO *); ABC `https://abcnews.go.com/abcnews/politicsheadlines` (→ abcnews.com, 25, CDATA, ACAO *); CBS `https://www.cbsnews.com/latest/rss/politics` (30); PBS `https://www.pbs.org/newshour/feeds/rss/politics` (20).

**OFFICIAL column (optional):**
- White House releases: `https://www.whitehouse.gov/news/feed/` — 200, 30 items, **617 KB** (full bodies) → regex only `<title>`, `<link>`, `<pubDate>`; first: "White House Access Is a Privilege — Not a Right" `https://www.whitehouse.gov/releases/2026/09/white-house-access-is-a-privilege-not-a-right/`. (`/feed/` is 404.)
- Executive orders (JSON, ACAO *): `https://www.federalregister.gov/api/v1/documents.json?conditions%5Bpresidential_document_type%5D=executive_order&order=newest&per_page=5&fields%5B%5D=title&fields%5B%5D=executive_order_number&fields%5B%5D=signing_date&fields%5B%5D=publication_date&fields%5B%5D=html_url&fields%5B%5D=document_number` → `{count:1564, results:[{executive_order_number:"14428", signing_date:"2026-09-16", title:"Providing Meaningful Water Quality Improvements…", html_url:…}]}`. (`presidential_document_type` is valid in `conditions[]` only, not `fields[]`.)

DEAD (do not retry): AP `apnews.com/hub/politics.rss` (403 Cloudflare challenge), Reuters `/politics/rss` (401 DataDome) and `/arc/outboundfeeds/...` (404), C-SPAN `/rss/` (410), CNN `rss.cnn.com/rss/cnn_allpolitics.rss` (stale 2022–2024), Yahoo/Newsweek/WSJ/USA Today feeds (404/406/redirect), GDELT (429 shared-IP limits), Google News topic-ID feed `CAAqIggKIhxDQkFTRHdvSkwyMHZNRFZ4ZERBU0FtVnVLQUFQAQ` (302→400).

Minimal Worker RSS parser:
```js
const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, it]) => {
  const g = (t) => { const m = it.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)<\\/${t}>`)); return m ? m[1].replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1').trim() : ''; };
  const src = it.match(/<source url="([^"]*)">([^<]*)<\/source>/);
  let title = decodeEntities(g('title')); if (src) title = title.replace(new RegExp(`\\s+-\\s+${escapeRe(decodeEntities(src[2]))}$`), '');
  const pd = g('pubDate').replace(/\bEDT\b/, '-0400').replace(/\bEST\b/, '-0500');
  return { title, link: g('link'), source: src ? src[2] : FEED_NAME, pubDate: new Date(pd).toISOString(), guid: g('guid') || g('link') };
});
```

---

## 4. PORTRAIT

- **Local file (use this):** `(research scratch, not in repo) portrait.jpg` — 1638×2048, 1,125,802 bytes, JPEG baseline, sha1 `300ddda58741aff65cfa7a368f61f37d97ba7e99` (matches Commons). Copy into `public/portrait-full.jpg`.
- **Web-size copy (recommended hero):** `(research scratch, not in repo) verify_portrait_960w.jpg` — 960×1200, 158,784 bytes, sha1 `05aa1f07d5b631e4e9d530b67d532d790129b903`. Copy to `public/portrait.jpg`. Also available: `portrait_1280w.jpg` (1280×1600, 277,707 B), `verify_portrait_3x4.jpg` (3072×4096, 1,028,829 B, sha1 `918bfbca978c4fcb4116d6574f7cd7c17cd093ad`, tight 3:4), `portrait_3x4_crop.jpg` (2687×3583, 889,117 B).
- **Source URL (original):** `https://upload.wikimedia.org/wikipedia/commons/1/16/Official_Presidential_Portrait_of_President_Donald_J._Trump_%282025%29.jpg` (200, image/jpeg, ACAO *). Commons page: `https://commons.wikimedia.org/wiki/File:Official_Presidential_Portrait_of_President_Donald_J._Trump_(2025).jpg` (pageid 166661524). Thumbs (only allow-listed widths 120/250/330/500/960/1280/1920/3840 work; 800 → HTTP 400): `https://upload.wikimedia.org/wikipedia/commons/thumb/1/16/Official_Presidential_Portrait_of_President_Donald_J._Trump_%282025%29.jpg/960px-Official_Presidential_Portrait_of_President_Donald_J._Trump_%282025%29.jpg` (verified 200, 158,784 B). 3:4 max-res: `https://upload.wikimedia.org/wikipedia/commons/7/76/Official_Presidential_Portrait_of_President_Donald_J._Trump_%282025%29_%283x4%29.jpg`. White House originals: `https://www.whitehouse.gov/wp-content/uploads/2025/06/President-Donald-Trump-Official-Presidential-Portrait.png` (3000×1688 landscape RGBA, 3.49 MB, ACAO *) and `https://www.whitehouse.gov/wp-content/uploads/2026/01/President-Donald-Trump-Official-Presidential-Portrait.png-1-1.jpg` (756×839).
- **License:** Commons template `{{PD-USGov-POTUS}}`; extmetadata `LicenseShortName="Public domain"`, `UsageTerms="Public domain"`, `Copyrighted="False"`, `AttributionRequired="false"`. Rendered license text: "This file is a work of an employee of the Executive Office of the President of the United States, taken or made as part of that person's official duties. As a work of the U.S. federal government, it is in the public domain." Permission field: "This work is copyright-free and is therefore in the public domain under the terms of Title 17, Chapter 1, Section 105 of the U.S Code." Photographer Daniel Torok, dated 2025-06-02. Footer credit: `Official White House portrait, June 2025 (photo: Daniel Torok) — public domain, 17 U.S.C. § 105`.
- Commit the file; do not hotlink Wikimedia. No runtime call needed. (Optional swap-detector: `https://en.wikipedia.org/api/rest_v1/page/summary/Donald_Trump` → `originalimage.source`, ACAO *.)

---

## 5. CLOUDFLARE

Use a single Worker with static assets (NOT Pages — Pages docs say "Start new projects with Workers"; Cron Triggers are Workers-only). Repo layout: `public/` (index.html, style.css, portrait.jpg), `src/index.js`, `wrangler.jsonc`, `package.json`, `.nvmrc` (optional, `24`).

### 5.1 wrangler.jsonc
```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "williteverend",                 // MUST equal the Worker name typed in the dashboard or Workers Builds fails
  "main": "src/index.js",                  // required
  "compatibility_date": "2026-09-21",
  "assets": {
    "directory": "./public",
    "binding": "ASSETS",
    "html_handling": "auto-trailing-slash",
    "not_found_handling": "none",          // keep "none": with any other value + compat_date >= 2025-04-01, browser navigations to /api/* never reach the Worker
    "run_worker_first": ["/api/*"]         // /api/* always hits fetch(); everything else is asset-first
  },
  "triggers": { "crons": ["*/10 * * * *", "5 * * * *"] },   // UTC; Free plan = 5 triggers/account
  "kv_namespaces": [ { "binding": "STATE", "id": "<paste id from: npx wrangler kv namespace create STATE>" } ],  // omit until the namespace exists
  "observability": { "enabled": true }
  // Add ONLY after the zone is Active (deploy fails before then; or do it in the dashboard instead):
  // "routes": [ { "pattern": "williteverend.com", "custom_domain": true }, { "pattern": "www.williteverend.com", "custom_domain": true } ]
}
```
`package.json`: `{ "name": "williteverend", "private": true, "scripts": { "dev": "wrangler dev", "deploy": "wrangler deploy" }, "devDependencies": { "wrangler": "^4" } }` (Workers Builds uses the wrangler version pinned here; build image Node 24.18.0 default, Ubuntu 24.04).

### 5.2 src/index.js skeleton
```js
const UA = 'Mozilla/5.0 (compatible; williteverend/1.0; +https://williteverend.com)';
const TERM_END = Date.parse('2029-01-20T17:00:00Z');
const json = (data, sMax = 60) => new Response(JSON.stringify(data), { headers: {
  'content-type': 'application/json; charset=utf-8', 'cache-control': `public, s-maxage=${sMax}, max-age=30`, 'access-control-allow-origin': '*' } });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/snapshot' || url.pathname === '/api/news') {
      const cache = caches.default, key = new Request(url.toString(), request);
      let res = await cache.match(key);
      if (!res) {
        const body = await env.STATE.get(url.pathname === '/api/news' ? 'news' : 'snapshot', 'json');
        if (!body) { ctx.waitUntil(refresh(env, true)); return json({ error: 'warming up' }, 5); }
        res = json(body, 60);
        ctx.waitUntil(cache.put(key, res.clone()));   // Cache API is per-datacenter; KV is the global source of truth
      }
      return res;
    }
    if (url.pathname.startsWith('/api/')) return new Response('Not found', { status: 404 });
    return env.ASSETS.fetch(request);
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(refresh(env, controller.cron === '5 * * * *'));   // hourly run also pulls the 445 KB Polymarket 2028 event + approval + news
  }
};

async function refresh(env, heavy) {
  const get = (u, h = {}) => fetch(u, { headers: { 'user-agent': UA, ...h } });   // NEVER set an Origin header (Kalshi 403s)
  const [kalshi, poly, pmTrump28, pmNom28] = await Promise.allSettled([
    get('https://api.elections.kalshi.com/trade-api/v2/markets?tickers=KXTRUMPOUT27-27-JAN2029,KXTRUMPOUT27-27-28,KXTRUMPOUT27-27-DJT,KXTRUMPREMOVE,KXTRUMPRESIGN,KXIMPEACH-29-JAN20,KXIMPEACH-28-JAN01,KXAMEND25-29,KXPRESPERSON-28-DTRU,KXPRESNOMR-28-DJT,KXTRUMPRUN-28NOV07,KXPRESELECTIONOCCUR-28,KXPRESPARTY-2028-D,KXPRESPARTY-2028-R,KXMARTIAL-29JAN20,KXINSURRECTION-29').then(r => r.json()),
    get('https://gamma-api.polymarket.com/events/keyset?slug=trump-out-as-president-before-2027&slug=will-trump-be-impeached-by-december-31-2026&slug=will-trump-resign-by-december-31-2026&slug=trump-removed-via-25th-amendment-before-2027&slug=how-low-will-trumps-approval-rating-go-in-2026&slug=will-trump-be-impeached-before-his-term-ends&slug=will-trump-repeal-presidential-term-limits-in-2026').then(r => r.json()),
    get('https://gamma-api.polymarket.com/markets/slug/will-donald-trump-win-the-2028-us-presidential-election').then(r => r.json()),
    get('https://gamma-api.polymarket.com/markets/slug/will-donald-trump-win-the-2028-republican-presidential-nomination').then(r => r.json()),
  ]);
  const prev = (await env.STATE.get('snapshot', 'json')) || {};
  const snap = buildSnapshot({ kalshi, poly, pmTrump28, pmNom28, prev, override: await env.STATE.get('override') }); // §1.6–1.8 math; per-source ok flags; keep prev values for failed sources
  await env.STATE.put('snapshot', JSON.stringify(snap));            // 1 key, ≤144 writes/day (Free: 1,000 writes/day, 1 write/s/key)
  if (heavy) { /* approval (§2), 2028 events (§1.5), monthly-market discovery (§1.1.1), news (§3) → env.STATE.put('news', …), env.STATE.put('approval', …) */ }
}
```
Snapshot shape suggestion: `{ updatedAt, verdict: "NO"|"YES", daysLeft (client recomputes), ends: {pct, inputs:{…}}, early: {pct, inputs:{…}}, groups: { early:[…], stays:[…], approval:[…], election2028:[…] }, approval:{approve,disapprove,net,sources:[…]}, sources:{kalshi:{ok,at}, polymarket:{ok,at}, nyt:{ok,at}, sb:{ok,at}} }` with each market row `{ label, venue, id, prob, bid, ask, last, volume, endDate, thin, link, embed }`.

KV commands: `npx wrangler kv namespace create STATE` → paste `id`; manual flip `npx wrangler kv key put --binding STATE override YES --remote` (wrangler 4 defaults kv commands to --local; un-flip with `kv key delete ... --remote`, not `put ... NO`); `env.STATE.put(key, value, { expirationTtl: >=60 })` if a TTL is wanted (don't TTL `snapshot` — it is the last-good fallback). Local cron test: `npx wrangler dev` then `curl "http://localhost:8787/cdn-cgi/local/scheduled"`.

### 5.3 GitHub → Workers Builds
1. `cd <project> && git init && git add -A && git commit -m "init" && gh repo create williteverend --private --source=. --push` (Chrome is signed into GitHub; `gh auth login` if the CLI isn't).
2. Cloudflare dashboard → **Workers & Pages → Create application → Import a repository → Get started** → pick the GitHub account (installs the "Cloudflare Workers and Pages" GitHub App if needed) → select `williteverend` → **Worker name = `williteverend`** (must match `wrangler.jsonc name`), production branch `main`, root directory `/`, build command empty, deploy command `npx wrangler deploy` (default), non-production deploy `npx wrangler versions upload` (default), API token auto-generated → **Save and Deploy**. Preview at `https://williteverend.<account-subdomain>.workers.dev`.
3. Every push to `main` deploys; other branches upload preview versions. Settings later under Worker → Settings → Build. Limits: 3,000 build-min/month, 1 concurrent build, 20-min timeout. Commit `wrangler.jsonc` BEFORE connecting (otherwise autoconfig opens a PR).

### 5.4 Domain: GoDaddy → Cloudflare → Custom Domain
Live state (dig @1.1.1.1, 2026-09-21): NS `ns29.domaincontrol.com` / `ns30.domaincontrol.com`; **DNSSEC unsigned, no DS → nothing to turn off**; apex A `3.33.130.190`, `15.197.148.33` (GoDaddy parking); `www` CNAME → `williteverend.com`; registrar GoDaddy, created 2026-09-22T04:31:59Z, expires 2031-09-22.
1. Cloudflare dashboard → **Domains → Onboard a domain** → `williteverend.com` → choose manual DNS (or quick scan) → **Free** plan → Continue. If quick scan imported records, DELETE the two parking A records on the apex and the `www` CNAME (a Custom Domain cannot be created on a hostname with an existing CNAME).
2. Copy the two assigned nameservers (`<name>.ns.cloudflare.com`, shown in onboarding and on the zone Overview).
3. GoDaddy → `https://dcc.godaddy.com/control/portfolio` → `williteverend.com` → **DNS → Nameservers → "I'll use my own nameservers"** → paste both → **Save → Continue** (Domain Protection may prompt a one-time code). Propagation minutes to 24 h; check `dig ns williteverend.com @1.1.1.1`; zone status Pending → Active (email on activation).
4. Worker → **Settings → Domains & Routes → Add → Custom Domain** → `williteverend.com` → Add Custom Domain; repeat for `www.williteverend.com` (or proxied A `www` → `192.0.2.0` + a redirect rule). Cloudflare creates the DNS record and an Advanced Certificate; do not pre-create A/CNAME on those hostnames. API alternative: `PUT /accounts/{account_id}/workers/domains` body `{ "hostname": "williteverend.com", "service": "williteverend", "zone_name": "williteverend.com" }`.
5. Optionally disable `workers.dev` (`"workers_dev": false` or Settings → Domains & Routes).

Free-plan limits that matter: 100,000 req/day, 10 ms CPU/req, 50 subrequests/req (the cron makes < 20), 5 cron triggers/account, KV 100k reads/day + 1,000 writes/day (Cache API in front of KV keeps reads low), 20,000 asset files / 25 MiB each. Cache API: `cache.put` ignores `stale-while-revalidate`; contents are per-datacenter; never cache responses with `Set-Cookie`.

---

## 6. CAVEATS (from the verifiers)

1. Polymarket `/events?...`, `/markets?...`, `/events?tag_slug=` are DEPRECATED at runtime (sunset header already past). Use `/events/slug/`, `/markets/slug/`, `/events/keyset` only. Rate limits published; `/events/keyset` caps at 100/page and rejects `offset`.
2. Gamma quirks: `outcomePrices`/`outcomes`/`clobTokenIds` are JSON strings; `volume`/`liquidity` strings on markets, numbers on events; `lastTradePrice`/`volume` can be `null`; 76/128 markets in the 2028 event lack `outcomePrices`; placeholder slugs are reused for real candidates. Gamma event `endDate` (04:59Z) vs CLOB `end_date_iso` (00:00Z) differ. CLOB `/book` bids ascending, asks descending. Passing a conditionId to `prices-history?market=` silently returns `[]`.
3. CORS: Gamma and CLOB send `*` only when an Origin header is present (browsers do); data-api sends `*` always; Kalshi returns 403 to any foreign Origin; Datawrapper sends `*` only with Origin; NYT CSV `*`; Commons API needs `&origin=*`.
4. Kalshi: `KXTRUMPOUT27` EXCLUDES death (settles at last trade); "impeached" markets are House-vote only; `KXAMEND25-29` resolves Yes on a temporary §3 transfer; approval events roll daily/weekly (discover via `/events?series_ticker=…&status=open`); candlestick timestamps must be computed at runtime; `KXPRESPARTY` includes 2032 markets; series `KX3RDTERM`/`KXTRUMPOUT` exist with 0 markets; kalshi.com HTML 429s curl and blocks iframes.
5. The Polymarket monthly "out by <month>" slug is unpredictable and there is currently no October market — the UI must tolerate an empty slot. Its endDate ties with unrelated events, so filter on the slug regex + `endDate > now`.
6. The hazard-extrapolated 37.9% is extremely sensitive to the seed market (Sep-30 market gives 13%; annualized hazards 18.5% vs 5.9%) and long-dated Polymarket longshots have a price floor — never headline it. Thin markets (approval hit-37/36/34, impeached-by-Dec-2027, `KXTRUMPRUN-28NOV07` spread 0.08) must be gated by liquidity/spread.
7. Approval: NYT and Datawrapper URLs are undocumented and could move; Datawrapper dataset URLs are version-pinned for a year (re-resolve every refresh); VoteHub's approval feed is stale (and Kalshi's `KXTRUMPAPPROVALYEAR`/`…BELOW` resolve on it); YouGov is a single weekly pollster on an `api-test` host with no CORS; RCP needs the exact Chrome UA + Accept-Language and sets a DataDome cookie (fetch ≤ hourly); DDHQ/51+1 are HTML scrapes (51+1 robots.txt blocks AI crawlers; its API is key-gated); SIN data is CC BY-NC 4.0; FiftyPlusOne runs ~3 pts below other aggregators.
8. News: Google News RSS terms say personal/non-commercial; its direct-link decoder is an undocumented RPC (cache + fallback); Politico pubDates use EDT/EST; several feeds wrap fields in CDATA; whitehouse.gov feed is 617 KB; NPR's ACAO is pinned to apps.npr.org; Roll Call uses non-RFC822 dates (unused). AP/Reuters/C-SPAN/CNN feeds are dead.
9. Portrait: only allow-listed thumbnail widths resolve on Wikimedia (800px → 400); the Commons "Official White House PNG version" is a 1335×1688 non-transparent upload, not the 3000×1688 whitehouse.gov topper; the "January 2025" Commons file is the different inaugural portrait.
10. Cloudflare: `routes` with `custom_domain:true` breaks `wrangler deploy` until the zone is Active; dashboard Worker name must equal wrangler `name`; SPA/404 `not_found_handling` + compat date ≥ 2025-04-01 swallows `/api/*` navigations unless `run_worker_first` covers them; Cache API is per-datacenter and unverified on workers.dev previews; Workers Builds ignores wrangler Custom Builds; GoDaddy may require a 2SV code to save nameservers.
11. All values above were observed 2026-09-22 06:21–06:30 UTC (research/verification passes ~06:00–06:15 UTC) and move continuously; Polymarket markets are display-only for US users.

Raw responses from this synthesis pass: `k_batch.json`, `pm_keyset.json`, `pm_will-donald-trump-win-*.json`, `pm_ph.json`, `nyt_avg.csv`, `sb.csv`, `sin.csv`, `rcp.html`, `yg.json`, `f_*.xml/.hdr` in `(research scratch, not in repo) `. Earlier passes: `polymarket_markets.json`, `polymarket_verification.json`, `kalshi_summary.json`, `approval_sources_summary.json`, `approval_verification.json`, `news_feeds_summary.txt`, `gnews_decode.py`, `verify/` in the same directory.

---

## 7. ADDENDUM (2026-09-22, after deploy)

- Kalshi LIST endpoints (`/markets?tickers=`, `/markets?event_ticker=`) return HTTP 429 `too_many_requests` to Cloudflare Workers' shared egress IPs regardless of User-Agent; the single-market endpoint `/markets/{ticker}` and `/events/{ticker}?with_nested_markets=true` return 200 from the same edge. The Worker falls back to per-ticker fetches (see README "Kalshi and 429s").
- `api.kalshi.com` (non-elections host) returns Cloudflare error 1016 (origin DNS) — dead; keep `api.elections.kalshi.com`.
- Headless Chrome on macOS enforces a ~500px minimum window width, so `--window-size=390,…` screenshots are a crop of a wider layout; use real device emulation for phone checks.
