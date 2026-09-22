// williteverend.com — single Cloudflare Worker: static assets + server-rendered "/" + /api/state + /api/news + cron refresh.
//
// CPU budget: the Workers Free plan allows 10 ms CPU per invocation (HTTP request AND cron tick). Every refresh
// therefore does only the cheap market pulls, plus at most ONE heavy job (approval | election2028 | news) chosen
// by src/lib/schedule.js. A cold start (empty KV) does the light refresh inline and nothing else.
import config from '../config.json' with { type: 'json' };
import { parseKalshiBatch, parsePolymarketKeyset, parsePolymarketMarket, parsePolymarket2028, parseKalshi2028, pickMonthlyOutEvent } from './lib/markets.js';
import { parseNyt, parseDatawrapperVersion, parseSilverBulletin } from './lib/csv.js';
import { parseRss, mergeItems } from './lib/rss.js';
import { buildSnapshot, computeApproval, KALSHI_TICKERS, PM_KEYSET_EVENTS, PM } from './lib/snapshot.js';
import { pageVars, fillTemplate, fmtDate, daysLine } from './lib/render.js';
import { pickJob, JOBS } from './lib/schedule.js';
import { kalshiSigner } from './lib/kalshiAuth.js';

const UA = 'Mozilla/5.0 (compatible; williteverend/1.0; +https://williteverend.com)';
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2';
const GAMMA = 'https://gamma-api.polymarket.com';
const FEEDS = [
  // Direct-link feeds first so dedupe keeps the publisher URL over the Google News stub.
  { name: 'The Guardian', homepage: 'https://www.theguardian.com', url: 'https://www.theguardian.com/us-news/donaldtrump/rss' },
  { name: 'Politico', homepage: 'https://www.politico.com', url: 'https://rss.politico.com/white-house.xml' },
  { name: 'The Hill', homepage: 'https://thehill.com', url: 'https://thehill.com/homenews/administration/feed/' },
  { name: 'Google News', homepage: 'https://news.google.com', url: `https://news.google.com/rss/search?q=${encodeURIComponent(config.newsQuery || 'Trump administration')}+when:2d&hl=en-US&gl=US&ceid=US:en`, google: true },
];
const EMPTY_NEWS = { updatedAt: null, items: [] };
// Kalshi answers HTTP 429 to the Workers' shared egress IPs (anonymous traffic is limited per IP) while the same
// request from anywhere else is a 200. Mitigation here: a bounded wall-clock retry. The real fix needs a
// credential only the owner can create — an API key (secrets KALSHI_KEY_ID + KALSHI_PRIVATE_KEY → signed
// requests, see src/lib/kalshiAuth.js) or the GitHub Actions relay (.github/workflows/kalshi.yml → KV `kalshi`,
// read below when the direct call fails). Both paths are inert until configured. See README "Kalshi and 429s".
export const tuning = { retries: 2, retryDelayMs: () => 2000 + Math.random() * 2000, relayMaxAgeMs: 45 * 60e3 };
const RELAY_KEY = 'kalshi';

// Security headers for the rendered page. connect-src must gain https://clob.polymarket.com and
// https://data-api.polymarket.com if the optional §1.9 browser-side live tick / sparkline is ever added.
const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': "default-src 'self'; img-src 'self' data:; frame-src https://embed.polymarket.com; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

// ---------- helpers ----------
const json = (data, sMax = 60, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, s-maxage=${sMax}, max-age=30`, 'access-control-allow-origin': '*', 'x-content-type-options': 'nosniff' },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * Upstream GET. NEVER forwards an Origin header (Kalshi 403s on foreign origins). `headers` may be a function
 * (called per attempt, for signed requests whose timestamp must be fresh). `retries` > 0 re-tries a 429 / 5xx
 * after a 2–4 s jittered wait (wall clock, not CPU, so it costs nothing against the Free-plan CPU budget).
 */
async function get(url, { ua = UA, timeout = 15000, headers = {}, retries = 0 } = {}) {
  for (let i = 0; ; i++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort('timeout'), timeout);
    try {
      const extra = typeof headers === 'function' ? await headers(url) : headers;
      const res = await fetch(url, { headers: { 'user-agent': ua, accept: '*/*', ...extra }, signal: ctl.signal, redirect: 'follow' });
      if (res.ok) return res;
      if (i < retries && (res.status === 429 || res.status >= 500)) { await sleep(tuning.retryDelayMs(i)); continue; }
      throw new Error(`HTTP ${res.status} ${url}`);
    } finally { clearTimeout(t); }
  }
}
const getJson = (url, o) => get(url, o).then((r) => r.json());
const getText = (url, o) => get(url, o).then((r) => r.text());

/** Run a fetch+parse; on failure return { ok:false, error } instead of throwing. */
async function attempt(fn) {
  try { return { ok: true, value: await fn(), at: new Date().toISOString() }; }
  catch (e) { return { ok: false, error: String(e && e.message || e).slice(0, 200) }; }
}
const half = (n) => Math.ceil(n / 2);
const reason = (r) => String((r && r.message) || r).slice(0, 120);

// ---------- upstream pulls ----------
// Both venues answer HTTP 200 with a silently shorter list for unknown tickers/slugs, so success requires
// at least half of the expected markets; anything less is a failure and the previous good map is kept.
const kalshiOpts = (env) => ({ retries: tuning.retries, headers: kalshiSigner(env) || {} });
const kalshiBatch = (json) => {
  const markets = parseKalshiBatch(json);
  const missing = KALSHI_TICKERS.filter((t) => !markets[t]);
  const hit = KALSHI_TICKERS.length - missing.length;
  if (hit < half(KALSHI_TICKERS.length)) throw new Error(`Kalshi: only ${hit}/${KALSHI_TICKERS.length} tickers returned`);
  return { markets, missing, warning: null };
};
/** KV `kalshi` written by the GitHub Actions relay: { fetchedAt, batch, election2028 }. null unless present and fresh. */
async function readRelay(env, now) {
  let doc = null;
  try { doc = await env.STATE.get(RELAY_KEY, 'json'); } catch { return { doc: null, why: 'relay unreadable' }; }
  if (!doc || !doc.fetchedAt) return { doc: null, why: null };
  const age = now - Date.parse(doc.fetchedAt);
  if (!(age < tuning.relayMaxAgeMs)) return { doc: null, why: `relay stale (${Math.round(age / 60e3)}m old)` };
  return { doc, why: null };
}
const fetchKalshi = async (env, now = Date.now()) => {
  try { return await getJson(`${KALSHI}/markets?tickers=${KALSHI_TICKERS.join(',')}`, kalshiOpts(env)).then(kalshiBatch); }
  catch (e) {
    const relay = await readRelay(env, now);
    if (!relay.doc || !relay.doc.batch) throw relay.why ? new Error(`${reason(e)}; ${relay.why}`) : e;
    return { ...kalshiBatch(relay.doc.batch), at: relay.doc.fetchedAt, via: 'relay', warning: `direct fetch failed (${reason(e)}); values via the relay` };
  }
};
const fetchPolymarket = async () => {
  const keyset = await getJson(`${GAMMA}/events/keyset?${PM_KEYSET_EVENTS.map((s) => `slug=${s}`).join('&')}`);
  const got = new Set((keyset && keyset.events || []).map((e) => e.slug));
  const missing = PM_KEYSET_EVENTS.filter((s) => !got.has(s));
  const hit = PM_KEYSET_EVENTS.length - missing.length;
  if (hit < half(PM_KEYSET_EVENTS.length)) throw new Error(`Polymarket: only ${hit}/${PM_KEYSET_EVENTS.length} events returned`);
  const markets = parsePolymarketKeyset(keyset);
  const slugs = [PM.WIN2028, PM.NOM2028];
  const extra = await Promise.allSettled(slugs.map((s) => getJson(`${GAMMA}/markets/slug/${s}`).then(parsePolymarketMarket)));
  const warnings = [];
  extra.forEach((r, i) => {
    if (r.status === 'fulfilled') markets[r.value.id] = r.value;
    else { missing.push(slugs[i]); warnings.push(`${slugs[i]}: ${reason(r.reason)}`); }   // best-effort, but never silent
  });
  return { markets, missing, warning: warnings.join('; ') || null };
};
const fetchMonthly = async (slug) => {
  if (!slug) return null;
  const ev = await getJson(`${GAMMA}/events/slug/${slug}`);
  const markets = parsePolymarketKeyset({ events: [ev] });
  const m = markets[slug] || Object.values(markets)[0];
  if (!m) return null;
  const label = m.endDate ? `Out as President by ${fmtDate(m.endDate)}` : 'Out as President this month';
  return { ...m, label };
};
const discoverMonthly = async (now = Date.now()) => {
  const j = await getJson(`${GAMMA}/events/keyset?title_search=${encodeURIComponent('out as president')}&closed=false&include_markets=false&limit=50&order=volume&ascending=false`);
  return pickMonthlyOutEvent(j, now);
};
// 20 per venue (Kalshi lists 30, Polymarket ~52 priced): mergeElection2028 slices to the top 8 AFTER merging, so
// a person ranked 11th on one venue and 7th on the other still shows both prices.
const ELECTION_DEPTH = 20;
const fetchElection2028 = async (env, now = Date.now()) => {
  const kalshiLeg = async () => {
    try { return await getJson(`${KALSHI}/markets?event_ticker=KXPRESPERSON-28&status=open&limit=200`, kalshiOpts(env)).then((j) => parseKalshi2028(j, ELECTION_DEPTH)); }
    catch (e) {
      const relay = await readRelay(env, now);
      if (!relay.doc || !relay.doc.election2028) throw e;
      return parseKalshi2028(relay.doc.election2028, ELECTION_DEPTH);
    }
  };
  const [k, p] = await Promise.allSettled([
    kalshiLeg(),
    getJson(`${GAMMA}/events/slug/presidential-election-winner-2028`).then((j) => parsePolymarket2028(j, ELECTION_DEPTH)),
  ]);
  if (k.status === 'rejected' && p.status === 'rejected') throw new Error(`2028: ${reason(k.reason)} / ${reason(p.reason)}`);
  return { kalshi: k.status === 'fulfilled' ? k.value : null, polymarket: p.status === 'fulfilled' ? p.value : null, at: new Date().toISOString() };
};
const fetchApproval = async (prev, now = Date.now()) => {
  const [nyt, sb] = await Promise.all([
    attempt(() => getText('https://www.nytimes.com/newsgraphics/polls/approval/president-averages.csv', { ua: BROWSER_UA }).then(parseNyt)),
    attempt(async () => {
      const v = parseDatawrapperVersion(await getText('https://datawrapper.dwcdn.net/kSCt4/', { ua: BROWSER_UA }), 'kSCt4');
      return parseSilverBulletin(await getText(`https://datawrapper.dwcdn.net/kSCt4/${v}/dataset.csv`, { ua: BROWSER_UA }));
    }),
  ]);
  const prevSrc = (key) => ((prev && prev.approval && prev.approval.sources) || []).find((s) => s.key === key);
  const pickSrc = (r, key) => (r.ok ? r.value : prevSrc(key) && prevSrc(key).ok ? { approve: prevSrc(key).approve, disapprove: prevSrc(key).disapprove, date: prevSrc(key).date } : null);
  const out = computeApproval({ nyt: pickSrc(nyt, 'nyt'), sb: pickSrc(sb, 'sb'), now });
  for (const s of out.sources) { const r = s.key === 'nyt' ? nyt : sb; if (!r.ok) s.error = r.error; }
  out.updatedAt = new Date().toISOString();
  return out;
};
const fetchNews = async (now = Date.now()) => {
  const results = await Promise.all(FEEDS.map((f) => attempt(() => getText(f.url).then((xml) => parseRss(xml, f)))));
  const lists = results.map((r) => (r.ok ? r.value : []));
  const items = mergeItems(lists, { cap: 40, now });
  const sources = Object.fromEntries(FEEDS.map((f, i) => [f.name, { ok: results[i].ok, count: lists[i].length, error: results[i].error || null }]));
  if (!items.length) throw new Error('all feeds failed: ' + JSON.stringify(sources));
  return { updatedAt: new Date().toISOString(), items, sources };
};

// ---------- refresh (cron + cold start) ----------
/** KV writes must never take the page down (a 429 on the 1 write/s/key limit under concurrency just retries next tick). */
async function kvPut(env, key, value) {
  try { await env.STATE.put(key, JSON.stringify(value)); return true; }
  catch (e) { console.error(`kv put ${key}`, e); return false; }
}

/**
 * Light refresh (Kalshi batch + Polymarket keyset/2 slugs + the rolling monthly market) on every call, plus at
 * most one heavy job: `job` forces one, `schedule: true` picks the stale one (cron), neither = cold start.
 * `now` is injectable (the cron passes controller.scheduledTime; tests pin it) and threads through every
 * age-sensitive step: the scheduler, the monthly-market expiry, approval freshness and the news age cap.
 * Returns { snap, news, job }.
 */
export async function refresh(env, { schedule = false, job = null, now = Date.now() } = {}) {
  const prev = (await env.STATE.get('snapshot', 'json')) || null;
  const kvOverride = await env.STATE.get('override');
  if (!job && schedule) job = pickJob(prev, now);
  if (job && !JOBS.includes(job)) throw new Error(`unknown job ${job}`);

  let monthlySlug = (prev && prev.monthly && prev.monthly.id) || null;
  if (monthlySlug && prev.monthly.endDate && Date.parse(prev.monthly.endDate) < now) monthlySlug = null;
  const needDiscover = job === 'election2028' || !prev;
  const [kalshi, polymarket, disc] = await Promise.all([
    attempt(() => fetchKalshi(env, now)), attempt(fetchPolymarket), needDiscover ? attempt(() => discoverMonthly(now)) : Promise.resolve({ ok: true, value: monthlySlug }),
  ]);
  if (disc.ok) monthlySlug = disc.value;
  const monthly = await attempt(() => fetchMonthly(monthlySlug));

  const election2028 = job === 'election2028' ? await attempt(() => fetchElection2028(env, now)) : null;
  const approval = job === 'approval' ? await attempt(() => fetchApproval(prev, now)) : null;
  const news = job === 'news' ? await attempt(() => fetchNews(now)) : null;

  // Per-market carry-forward with provenance. A venue that is down keeps its whole previous map; a venue that
  // answered 200 but omitted some markets keeps the previous row for each omitted id (`carried: true`, with the
  // time it was really fetched) so a single missing ticker cannot move the headline. Fresh rows always win;
  // buildGroups only reads known ids, so orphaned previous rows never render. Spreading prev under fresh also
  // covers Polymarket, whose `missing` lists EVENT slugs while the map is keyed by MARKET slug.
  const carry = (r, key) => {
    const prevMap = (prev && prev.markets && prev.markets[key]) || {};
    const prevAt = prev && prev.sources && prev.sources[key] ? prev.sources[key].at : null;
    const keep = (row) => ({ ...row, carried: true, at: row.at || prevAt });
    if (!r.ok) return { ok: false, markets: Object.fromEntries(Object.entries(prevMap).map(([id, row]) => [id, keep(row)])), at: prevAt, error: r.error, carried: Object.keys(prevMap) };
    const at = r.value.at || r.at;
    const markets = {}, carried = [];
    for (const [id, row] of Object.entries(prevMap)) if (!r.value.markets[id]) { markets[id] = keep(row); carried.push(id); }
    for (const [id, row] of Object.entries(r.value.markets)) markets[id] = { ...row, carried: false, at };
    return { ok: true, markets, at, error: r.value.warning || null, partial: r.value.missing.length > 0, missing: r.value.missing, carried, via: r.value.via || null };
  };
  const snap = buildSnapshot({
    now, config, kvOverride,
    kalshi: carry(kalshi, 'kalshi'), polymarket: carry(polymarket, 'polymarket'),
    monthly: monthly.ok ? monthly.value : (prev && prev.monthly) || null,
    election2028: election2028 && election2028.ok ? election2028.value : (prev && prev.election2028) || null,
    approval: approval && approval.ok ? approval.value : (prev && prev.approval) || null,
    newsMeta: news ? { ok: news.ok, at: news.ok ? news.value.updatedAt : (prev && prev.sources && prev.sources.news && prev.sources.news.at) || null, error: news.error || null } : null,
    prev,
  });
  // Last ATTEMPT time per heavy job (drives the scheduler; a failing job cannot starve the others).
  snap.jobs = { ...((prev && prev.jobs) || {}), ...(job ? { [job]: new Date(now).toISOString() } : {}) };
  await kvPut(env, 'snapshot', snap);
  let newsDoc = null;
  if (news && news.ok) { newsDoc = news.value; await kvPut(env, 'news', newsDoc); }
  return { snap, news: newsDoc, job };
}

// ---------- state access (KV; cold start = ONE in-flight light refresh per isolate) ----------
let coldStart = null;
function coldRefresh(env) {
  if (!coldStart) coldStart = refresh(env).finally(() => { coldStart = null; });
  return coldStart;
}
async function getSnapshot(env) {
  return (await env.STATE.get('snapshot', 'json')) || (await coldRefresh(env)).snap;
}
/** News is only ever produced by the cron's news job; before that the section renders "unavailable". */
async function getNews(env) {
  return (await env.STATE.get('news', 'json')) || EMPTY_NEWS;
}

async function cached(request, ctx, build) {
  let cache = null;
  try { cache = caches.default; } catch { /* no Cache API (tests, exotic runtimes): build every time */ }
  const u = new URL(request.url);
  // Nothing in the render or /api handlers reads the query string, so ?utm_*/?fbclid=/?_= variants share one
  // entry (keyed on origin + path). Origin stays in the key: apex vs www vs workers.dev may legitimately differ.
  const path = u.pathname === '/index.html' ? '/' : u.pathname === '/api/snapshot' ? '/api/state' : u.pathname;
  const key = new Request(u.origin + path, { method: 'GET' });
  if (cache) { try { const hit = await cache.match(key); if (hit) return hit; } catch { /* cache unavailable */ } }
  const res = await build();
  if (cache && res.ok) { try { ctx.waitUntil(Promise.resolve(cache.put(key, res.clone())).catch(() => {})); } catch { /* ignore */ } }
  return res;
}

const siteOrigin = (url) => (config.links && config.links.site) || url.origin;

async function renderPage(request, env) {
  const url = new URL(request.url);
  const tplRes = await env.ASSETS.fetch(new Request(new URL('/index.html', url.origin), { method: 'GET' }));
  const tpl = await tplRes.text();
  let [snap, news] = await Promise.all([env.STATE.get('snapshot', 'json'), env.STATE.get('news', 'json')]);
  if (!snap) snap = (await coldRefresh(env)).snap;
  if (!news) news = EMPTY_NEWS;
  const html = fillTemplate(tpl, pageVars({ snap, news, origin: siteOrigin(url) }));
  return new Response(html, { headers: { ...HTML_HEADERS, 'cache-control': 'public, max-age=0, s-maxage=60' } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === 'OPTIONS') return new Response(null, { headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET' } });
    // `return await`, not `return`: a rejected promise returned from inside try/catch skips the catch, and the
    // catch below IS the "page renders even when KV is down" guarantee.
    try {
      if (path === '/api/state' || path === '/api/snapshot') return await cached(request, ctx, async () => json(await getSnapshot(env), 60));
      if (path === '/api/news') return await cached(request, ctx, async () => { const n = await getNews(env); return json(n, n.items.length ? 120 : 30); });
      if (path === '/api/health') return json({ ok: true, now: new Date().toISOString() }, 0);
      if (path === '/api/_probe') {
        // TEMPORARY diagnostic (remove after use): what does Kalshi answer from this edge? Fixed URL set only.
        const PROBES = {
          batch_bot: [`${KALSHI}/markets?tickers=KXTRUMPOUT27-27-JAN2029,KXTRUMPRESIGN`, UA],
          batch_browser: [`${KALSHI}/markets?tickers=KXTRUMPOUT27-27-JAN2029,KXTRUMPRESIGN`, BROWSER_UA],
          single_bot: [`${KALSHI}/markets/KXTRUMPRESIGN`, UA],
          single_browser: [`${KALSHI}/markets/KXTRUMPREMOVE`, BROWSER_UA],
          event_browser: [`${KALSHI}/markets?event_ticker=KXPRESPERSON-28&status=open&limit=200`, BROWSER_UA],
          batch_noua: [`${KALSHI}/markets?tickers=KXAMEND25-29,KXIMPEACH-29-JAN20`, ''],
        };
        const out = {};
        for (const [k, [u, ua]] of Object.entries(PROBES)) {
          try {
            const r = await fetch(u, { headers: { ...(ua ? { 'user-agent': ua } : {}), accept: 'application/json' } });
            out[k] = { status: r.status, headers: Object.fromEntries([...r.headers].filter(([h]) => /retry|cache|via|x-|cf-|server|date|content-type/i.test(h))), body: (await r.text()).slice(0, 120) };
          } catch (e) { out[k] = { error: String(e) }; }
        }
        return json({ colo: request.cf && request.cf.colo, out }, 0);
      }
      if (path.startsWith('/api/')) return json({ error: 'not found' }, 0, 404);
      if (path === '/' || path === '/index.html') return await cached(request, ctx, () => renderPage(request, env));
    } catch (e) {
      console.error('fetch fallback', path, e);
      if (path.startsWith('/api/')) return json({ error: String(e && e.message || e) }, 0, 500);
      // Page must still render: the template with the answer computed from config alone; and if even the asset
      // binding fails, a bare page with the answer and the countdown (both are pure config + clock).
      const snap = buildSnapshot({ config });
      let html;
      try {
        const tplRes = await env.ASSETS.fetch(new Request(new URL('/index.html', url.origin), { method: 'GET' }));
        if (!tplRes.ok) throw new Error(`template HTTP ${tplRes.status}`);
        html = fillTemplate(await tplRes.text(), pageVars({ snap, news: null, origin: siteOrigin(url) }));
      } catch (e2) {
        console.error('fetch fallback: template unavailable', e2);
        const d = daysLine(snap);
        html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Will it ever end?</title><main style="text-align:center;font-family:Georgia,serif"><h1 class="answer" id="answer" style="font-size:30vw;margin:.2em 0">${snap.verdict}</h1><p class="days" id="days" title="${d.title}">${d.text}</p></main>`;
      }
      return new Response(html, { status: 200, headers: { ...HTML_HEADERS, 'cache-control': 'no-store' } });
    }
    return env.ASSETS.fetch(request);
  },
  async scheduled(controller, env, ctx) {
    // Every tick: markets + one due heavy job. Locally, `?cron=news|approval|election2028` forces that job.
    const job = JOBS.includes(controller.cron) ? controller.cron : null;
    const now = Number.isFinite(controller && controller.scheduledTime) ? controller.scheduledTime : Date.now();
    await refresh(env, { schedule: true, job, now }).catch((e) => console.error('refresh failed', e));
  },
};
