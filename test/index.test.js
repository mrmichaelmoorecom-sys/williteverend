// Integration: the Worker's refresh()/scheduled() against a mocked fetch + Map-backed KV.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const keyset = JSON.parse(fx('pm_keyset.json'));
const monthlyEvent = keyset.events.find((e) => e.slug === 'dtrump-out-as-president-by-september-30');
const future = new Date(Date.now() + 20 * 86400e3).toISOString();
const NOW = Date.parse('2026-09-22T06:30:00Z');   // fixtures are dated 2026-09-20..22; never compare them to the wall clock

/** URL → response body, recorded in `calls`. Override per test with `routes`. */
function mockFetch(calls, routes = {}) {
  const text = (body, type = 'text/plain') => new Response(body, { status: 200, headers: { 'content-type': type } });
  const j = (o) => text(JSON.stringify(o), 'application/json');
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    for (const [k, v] of Object.entries(routes)) if (u.includes(k)) return typeof v === 'function' ? v(u) : v;
    if (u.includes('/markets?tickers=')) return text(fx('k_batch.json'), 'application/json');
    if (u.includes('/events/keyset?slug=')) return text(fx('pm_keyset.json'), 'application/json');
    if (u.includes('/markets/slug/will-donald-trump-win-the-2028-us')) return text(fx('pm_win2028.json'), 'application/json');
    if (u.includes('/markets/slug/will-donald-trump-win-the-2028-rep')) return text(fx('pm_nom2028.json'), 'application/json');
    if (u.includes('/events/keyset?title_search=')) return j({ events: [{ slug: 'dtrump-out-as-president-by-september-30', endDate: future }] });
    if (u.includes('/events/slug/dtrump-out-as-president-by-september-30')) return j({ ...monthlyEvent, endDate: future, markets: monthlyEvent.markets.map((m) => ({ ...m, endDate: future })) });
    if (u.includes('event_ticker=KXPRESPERSON-28')) return text(fx('k2028.json'), 'application/json');
    if (u.includes('/events/slug/presidential-election-winner-2028')) return text(fx('pm_ev2028.json'), 'application/json');
    if (u.includes('president-averages.csv')) return text(fx('nyt_avg.csv'), 'text/csv');
    if (u.endsWith('/kSCt4/')) return text(fx('dw_resolver.html'), 'text/html');
    if (u.includes('/kSCt4/7832/dataset.csv')) return text(fx('sb.csv'), 'text/csv');
    if (u.includes('theguardian.com')) return text(fx('f_guardian.xml'), 'application/rss+xml');
    if (u.includes('politico.com')) return text(fx('f_politico.xml'), 'application/rss+xml');
    if (u.includes('thehill.com')) return text(fx('f_hill.xml'), 'application/rss+xml');
    if (u.includes('news.google.com')) return text(fx('f_gnews.xml'), 'application/rss+xml');
    return new Response('nope', { status: 404 });
  };
}
function kv() {
  const m = new Map();
  return { m, get: async (k, type) => { const v = m.get(k); return v == null ? null : type === 'json' ? JSON.parse(v) : v; }, put: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); } };
}
const HEAVY = ['president-averages', 'dwcdn.net', 'theguardian', 'politico', 'thehill', 'news.google', 'event_ticker=KXPRESPERSON-28', 'presidential-election-winner-2028'];
const heavyCalls = (calls) => calls.filter((u) => HEAVY.some((h) => u.includes(h)));

const worker = await import('../src/index.js');
const { refresh } = worker;
worker.tuning.retryDelayMs = () => 0; worker.tuning.singlesGapMs = () => 0; worker.tuning.singlesBackoffMs = () => 0;   // the 2–4 s production backoff would only slow the suite

test('cold start (empty KV): light refresh only — no approval/news/2028 fetches — and snapshot is written', async () => {
  const calls = []; mockFetch(calls);
  const STATE = kv();
  const { snap, news, job } = await refresh({ STATE }, { now: NOW });
  assert.equal(job, null);
  assert.deepEqual(heavyCalls(calls), []);
  assert.ok(calls.some((u) => u.includes('/markets?tickers=')) && calls.some((u) => u.includes('/events/keyset?slug=')));
  assert.ok(calls.some((u) => u.includes('title_search=')), 'monthly discovery runs on cold start (cheap)');
  assert.equal(calls.length, 6);   // kalshi, keyset, 2 slugs, discovery, monthly event
  assert.ok(STATE.m.has('snapshot')); assert.ok(!STATE.m.has('news'));
  assert.equal(news, null);
  assert.equal(snap.verdict, 'NO'); assert.equal(snap.ends.pct, 89.6); assert.equal(snap.early.pct, 23.5);
  assert.equal(snap.sources.kalshi.ok, true); assert.equal(snap.sources.polymarket.ok, true);
  assert.equal(snap.stale, false);
  assert.equal(snap.monthly.id, 'dtrump-out-as-president-by-september-30');
  assert.match(snap.monthly.label, /^Out as President by /);
  assert.equal(snap.approval.approve, null);
  assert.equal(snap.election2028, null);
  assert.deepEqual(snap.jobs, {});
  // the fixture batch lacks 2 of the 18 expected tickers → flagged partial, still ok
  assert.equal(snap.sources.kalshi.partial, true);
  assert.deepEqual(snap.sources.kalshi.missing, ['KXTRUMPPRES-28', 'KXTRUMPAPPROVALBELOW-26DEC31-37']);
  assert.deepEqual(snap.sources.kalshi.carried, []);                     // nothing to carry on a cold start
  assert.equal(snap.sources.polymarket.partial, false);
  assert.equal(snap.updatedAt, new Date(NOW).toISOString());
  assert.equal(snap.confirmed, false);
});

test('scheduled ticks: one heavy job per tick, approval → election2028 → news, each persisted', async () => {
  const STATE = kv();
  let calls = []; mockFetch(calls);
  await refresh({ STATE }, { now: NOW });                     // cold start
  calls.length = 0;
  let r = await refresh({ STATE }, { schedule: true, now: NOW });
  assert.equal(r.job, 'approval');
  assert.ok(calls.some((u) => u.includes('president-averages')) && calls.some((u) => u.includes('dataset.csv')));
  assert.ok(!calls.some((u) => u.includes('news.google') || u.includes('event_ticker=KXPRESPERSON-28')));
  assert.equal(r.snap.approval.sources.length, 2);
  assert.equal(r.snap.approval.approve, 38.2);                // deterministic: the 7.5-day freshness gate sees the pinned clock
  assert.ok(r.snap.jobs.approval);
  const snapKv = JSON.parse(STATE.m.get('snapshot'));
  assert.equal(snapKv.approval.approve, r.snap.approval.approve);

  calls.length = 0;
  r = await refresh({ STATE }, { schedule: true, now: NOW });
  assert.equal(r.job, 'election2028');
  assert.ok(calls.some((u) => u.includes('event_ticker=KXPRESPERSON-28')) && calls.some((u) => u.includes('presidential-election-winner-2028')));
  assert.ok(calls.some((u) => u.includes('title_search=')), 'discovery rides with the 2028 job');
  assert.ok(!calls.some((u) => u.includes('president-averages') || u.includes('news.google')));
  assert.ok(r.snap.election2028.kalshi.length && r.snap.election2028.polymarket.length);
  assert.equal(r.snap.election2028.kalshi.length, 20);        // 20 deep per venue, merged, THEN top 8
  assert.equal(r.snap.election2028.polymarket.length, 20);
  const people = r.snap.groups.election2028.filter((x) => x.byVenue);
  assert.ok(people.length >= 5 && people.length <= 8);
  assert.ok(people.some((x) => x.label === 'J.D. Vance' && x.byVenue.Kalshi && x.byVenue.Polymarket), 'Vance merged across venues');
  assert.ok(people.some((x) => x.label === 'Josh Shapiro' && x.byVenue.Kalshi && x.byVenue.Polymarket), 'Shapiro (11th on Kalshi) merged across venues');

  calls.length = 0;
  r = await refresh({ STATE }, { schedule: true, now: NOW });
  assert.equal(r.job, 'news');
  assert.equal(calls.filter((u) => /theguardian|politico|thehill|news\.google/.test(u)).length, 4);
  assert.ok(r.news && r.news.items.length >= 30);
  assert.ok(STATE.m.has('news'));
  assert.equal(r.snap.sources.news.ok, true);
  assert.ok(r.news.items.every((it) => /^https?:\/\//.test(it.link)));

  // everything fresh → markets only
  calls.length = 0;
  r = await refresh({ STATE }, { schedule: true, now: NOW });
  assert.equal(r.job, null);
  assert.deepEqual(heavyCalls(calls), []);
  assert.ok(!calls.some((u) => u.includes('title_search=')), 'no rediscovery while the monthly slug is valid');

  // scheduled() with a forced job name (local `?cron=news`)
  calls.length = 0;
  await worker.default.scheduled({ cron: 'news', scheduledTime: NOW }, { STATE }, { waitUntil() {} });
  assert.equal(calls.filter((u) => /theguardian|politico|thehill|news\.google/.test(u)).length, 4);
  calls.length = 0;
  await worker.default.scheduled({ cron: '*/10 * * * *', scheduledTime: NOW }, { STATE }, { waitUntil() {} });
  assert.deepEqual(heavyCalls(calls), []);
  // scheduledTime drives the scheduler: an hour later the approval job is due again
  calls.length = 0;
  await worker.default.scheduled({ cron: '*/10 * * * *', scheduledTime: NOW + 3600e3 }, { STATE }, { waitUntil() {} });
  assert.ok(calls.some((u) => u.includes('president-averages')));
  assert.equal(JSON.parse(STATE.m.get('snapshot')).jobs.approval, new Date(NOW + 3600e3).toISOString());
});

test('approval carry-forward: a failing primary keeps its previous value (ok stays true, error recorded); cold start with one down is partial', async () => {
  const STATE = kv();
  const calls = []; mockFetch(calls);
  await refresh({ STATE }, { now: NOW });
  let { snap } = await refresh({ STATE }, { job: 'approval', now: NOW });
  assert.equal(snap.approval.approve, 38.2); assert.equal(snap.approval.disapprove, 59.1); assert.equal(snap.approval.net, -20.9);
  assert.equal(snap.approval.partial, false);
  assert.equal(snap.sources.nyt.ok, true); assert.equal(snap.sources.sb.ok, true);
  assert.ok(snap.approval.sources.every((x) => x.error === undefined));
  // dataset step 500s (resolver still fine): SB value reused, still ok, error recorded
  mockFetch(calls, { 'dataset.csv': () => new Response('boom', { status: 500 }) });
  ({ snap } = await refresh({ STATE }, { job: 'approval', now: NOW + 3600e3 }));
  assert.equal(snap.approval.approve, 38.2); assert.equal(snap.approval.partial, false);
  let sb = snap.approval.sources.find((x) => x.key === 'sb');
  assert.equal(sb.ok, true); assert.equal(sb.approve, 38.59664); assert.equal(sb.date, '2026-09-21');
  assert.match(sb.error, /HTTP 500 .*dataset\.csv/);
  assert.deepEqual(snap.sources.sb, { ok: true, at: '2026-09-21', error: sb.error });
  // the carry chains across a second failing run
  ({ snap } = await refresh({ STATE }, { job: 'approval', now: NOW + 2 * 3600e3 }));
  assert.equal(snap.approval.approve, 38.2); assert.equal(snap.approval.sources.find((x) => x.key === 'sb').ok, true);
  // resolver step 503s
  mockFetch(calls, { '/kSCt4/': () => new Response('nope', { status: 503 }) });
  ({ snap } = await refresh({ STATE }, { job: 'approval', now: NOW + 3 * 3600e3 }));
  assert.equal(snap.approval.approve, 38.2);
  assert.match(snap.approval.sources.find((x) => x.key === 'sb').error, /HTTP 503 .*kSCt4\/$/);
  // cold start with SB down: NYT only, partial
  const COLD = kv();
  mockFetch(calls, { '/kSCt4/': () => new Response('nope', { status: 503 }) });
  await refresh({ STATE: COLD }, { now: NOW });
  ({ snap } = await refresh({ STATE: COLD }, { job: 'approval', now: NOW }));
  assert.equal(snap.approval.partial, true); assert.equal(snap.approval.approve, 37.8);
  sb = snap.approval.sources.find((x) => x.key === 'sb');
  assert.ok(!sb.ok); assert.equal(snap.sources.sb.ok, false); assert.match(snap.sources.sb.error, /HTTP 503/);
  mockFetch(calls);
  ({ snap } = await refresh({ STATE: COLD }, { job: 'approval', now: NOW + 3600e3 }));
  assert.equal(snap.approval.partial, false); assert.equal(snap.approval.approve, 38.2);
  assert.equal(snap.approval.sources.find((x) => x.key === 'sb').error, undefined);
});

test('a 200 with an empty Kalshi list keeps the previous good map, ok=false, updatedAt frozen', async () => {
  const STATE = kv();
  const calls = []; mockFetch(calls);
  const first = (await refresh({ STATE }, { now: NOW })).snap;
  mockFetch(calls, { '/markets?tickers=': () => new Response('{"cursor":"","markets":[]}', { status: 200, headers: { 'content-type': 'application/json' } }) });
  const { snap } = await refresh({ STATE }, { schedule: true, now: NOW + 600e3 });
  assert.equal(snap.sources.kalshi.ok, false);
  assert.match(snap.sources.kalshi.error, /0 markets/);
  assert.equal(snap.sources.kalshi.at, first.sources.kalshi.at);
  assert.equal(Object.keys(snap.markets.kalshi).length, 16);
  assert.equal(snap.sources.kalshi.carried.length, 16);
  assert.ok(Object.values(snap.markets.kalshi).every((r) => r.carried === true && r.at === first.sources.kalshi.at));
  assert.equal(snap.ends.pct, 89.6);
  assert.deepEqual(snap.ends.venues, ['Kalshi', 'Polymarket']);
  assert.equal(snap.stale, false);                            // Polymarket was fresh
  // both venues empty → carried snapshot keeps its old updatedAt and is flagged stale
  mockFetch(calls, {
    '/markets?tickers=': () => new Response('{"cursor":"","markets":[]}', { status: 200 }),
    '/events/keyset?slug=': () => new Response('{"events":[]}', { status: 200 }),
  });
  const { snap: both } = await refresh({ STATE }, { schedule: true, now: NOW + 1200e3 });
  assert.equal(both.stale, true);
  assert.equal(both.updatedAt, snap.updatedAt);
  assert.match(both.sources.polymarket.error, /only 0\/7 events/);
  assert.equal(both.ends.pct, 89.6);
});

test('coverage threshold: fewer than half the expected tickers is a failure; a missing 2028 slug is recorded, not swallowed', async () => {
  const STATE = kv();
  const calls = []; mockFetch(calls);
  const full = JSON.parse(fx('k_batch.json'));
  mockFetch(calls, { '/markets?tickers=': () => new Response(JSON.stringify({ cursor: '', markets: full.markets.slice(0, 8) }), { status: 200 }) });
  let { snap } = await refresh({ STATE }, { now: NOW });
  assert.equal(snap.sources.kalshi.ok, false);
  assert.match(snap.sources.kalshi.error, /only 8\/18 tickers/);
  assert.deepEqual(snap.markets.kalshi, {});                  // nothing to carry on a cold start
  // the WIN2028 slug 404s on a warm KV: the previous row is carried, so the headline keeps both venues
  mockFetch(calls, { '/markets/slug/will-donald-trump-win-the-2028-us': () => new Response('{"type":"not found error"}', { status: 404 }) });
  ({ snap } = await refresh({ STATE }, { schedule: true, now: NOW + 600e3 }));
  assert.equal(snap.sources.polymarket.ok, true);
  assert.equal(snap.sources.polymarket.partial, true);
  assert.deepEqual(snap.sources.polymarket.missing, ['will-donald-trump-win-the-2028-us-presidential-election']);
  assert.deepEqual(snap.sources.polymarket.carried, ['will-donald-trump-win-the-2028-us-presidential-election']);
  assert.match(snap.sources.polymarket.error, /HTTP 404/);
  assert.equal(snap.ends.pct, 89.6);
  assert.deepEqual(snap.ends.venues, ['Kalshi', 'Polymarket']);
  assert.equal(snap.markets.polymarket['will-donald-trump-win-the-2028-us-presidential-election'].carried, true);
  assert.equal(snap.markets.polymarket['trump-out-as-president-before-2027'].carried, false);
});

test('partial 200: a single missing Kalshi ticker is carried from the last good map and cannot move the headline', async () => {
  const full = JSON.parse(fx('k_batch.json'));
  const without = (t) => new Response(JSON.stringify({ cursor: '', markets: full.markets.filter((m) => m.ticker !== t) }), { status: 200 });
  const { renderOdds } = await import('../src/lib/render.js');
  // cold start (no prev): nothing to carry → p_noelect null, 97.9%, flagged partial
  const COLD = kv();
  let calls = []; mockFetch(calls, { '/markets?tickers=': () => without('KXPRESELECTIONOCCUR-28') });
  let { snap } = await refresh({ STATE: COLD }, { now: NOW });
  assert.equal(snap.ends.inputs.p_noelect, null); assert.equal(snap.ends.pct, 97.9);
  assert.equal(snap.sources.kalshi.partial, true); assert.ok(snap.sources.kalshi.missing.includes('KXPRESELECTIONOCCUR-28'));
  assert.deepEqual(snap.sources.kalshi.carried, []);
  assert.doesNotMatch(renderOdds(snap, NOW), /class="warn"/);
  // warm KV: the row is carried → 89.6%
  const STATE = kv();
  calls = []; mockFetch(calls);
  const first = (await refresh({ STATE }, { now: NOW })).snap;
  mockFetch(calls, { '/markets?tickers=': () => without('KXPRESELECTIONOCCUR-28') });
  ({ snap } = await refresh({ STATE }, { schedule: true, now: NOW + 600e3 }));
  assert.equal(snap.sources.kalshi.ok, true); assert.equal(snap.sources.kalshi.partial, true);
  assert.deepEqual(snap.sources.kalshi.carried, ['KXPRESELECTIONOCCUR-28']);
  assert.equal(snap.ends.pct, 89.6); assert.equal(snap.ends.inputs.p_noelect, 0.083);
  assert.deepEqual(snap.ends.venues, ['Kalshi', 'Polymarket']);
  const row = snap.markets.kalshi['KXPRESELECTIONOCCUR-28'];
  assert.equal(row.carried, true); assert.equal(row.at, first.sources.kalshi.at);
  assert.equal(snap.markets.kalshi['KXTRUMPOUT27-27-JAN2029'].carried, false);
  const html = renderOdds(snap, NOW + 600e3);
  assert.doesNotMatch(html, /class="warn"/);   // a partial response is carried silently, not announced on the page
  // the carry chains across ticks (the row keeps its original fetch time)
  ({ snap } = await refresh({ STATE }, { schedule: true, now: NOW + 1200e3 }));
  assert.equal(snap.ends.pct, 89.6); assert.equal(snap.markets.kalshi['KXPRESELECTIONOCCUR-28'].at, first.sources.kalshi.at);
  // the venue is back: fresh row wins, nothing carried
  mockFetch(calls);
  ({ snap } = await refresh({ STATE }, { schedule: true, now: NOW + 1800e3 }));
  assert.deepEqual(snap.sources.kalshi.carried, []); assert.equal(snap.markets.kalshi['KXPRESELECTIONOCCUR-28'].carried, false);
  // both headline tickers absent (9/18 passes the coverage gate): still 89.6% on a warm KV
  mockFetch(calls, { '/markets?tickers=': () => new Response(JSON.stringify({ cursor: '', markets: full.markets.filter((m) => !['KXPRESELECTIONOCCUR-28', 'KXPRESPERSON-28-DTRU'].includes(m.ticker)).slice(0, 9) }), { status: 200 }) });
  ({ snap } = await refresh({ STATE }, { schedule: true, now: NOW + 2400e3 }));
  assert.equal(snap.sources.kalshi.ok, true); assert.equal(snap.ends.pct, 89.6);
  assert.ok(snap.sources.kalshi.carried.includes('KXPRESPERSON-28-DTRU') && snap.sources.kalshi.carried.includes('KXPRESELECTIONOCCUR-28'));
});

test('Kalshi 429: batch → per-ticker singles → KV relay → previous map', async () => {
  const STATE = kv();
  let calls = []; mockFetch(calls);
  const first = (await refresh({ STATE }, { now: NOW })).snap;
  const batch = JSON.parse(fx('k_batch.json'));
  const single = (u) => { const t = u.split('/markets/')[1]; const m = batch.markets.find((x) => x.ticker === t); return m ? new Response(JSON.stringify({ market: m }), { status: 200 }) : new Response('{"error":{"code":"not_found"}}', { status: 404 }); };
  // batch 429 (not retried — it is a known-persistent throttle) → 18 sequential singles (the 2 tickers absent
  // from the fixture 404, which is not retried = 18 calls) → ok, via 'singles', same headline
  calls = []; mockFetch(calls, { '/markets?tickers=': () => new Response('rate limited', { status: 429 }), '/trade-api/v2/markets/KX': single });
  let { snap } = await refresh({ STATE }, { schedule: true, now: NOW + 600e3 });
  assert.equal(calls.filter((u) => u.includes('/markets?tickers=')).length, 1);
  assert.equal(calls.filter((u) => /\/trade-api\/v2\/markets\/KX/.test(u)).length, 18);
  assert.equal(snap.sources.kalshi.ok, true); assert.equal(snap.sources.kalshi.via, 'singles'); assert.equal(snap.sources.kalshi.error, null);
  assert.equal(snap.ends.pct, 89.6); assert.equal(Object.keys(snap.markets.kalshi).length, 16);
  // singles partially missing (2 tickers 404) → still ok, warning names them, the 2 rows are carried from before
  calls = []; mockFetch(calls, { '/markets?tickers=': () => new Response('rate limited', { status: 429 }), '/trade-api/v2/markets/KXTRUMPRUN-28NOV07': () => new Response('x', { status: 404 }), '/trade-api/v2/markets/KX': single });
  ({ snap } = await refresh({ STATE }, { schedule: true, now: NOW + 900e3 }));
  assert.equal(snap.sources.kalshi.ok, true); assert.equal(snap.sources.kalshi.via, 'singles');
  assert.ok(snap.sources.kalshi.partial && snap.sources.kalshi.missing.includes('KXTRUMPRUN-28NOV07'));
  assert.ok(snap.sources.kalshi.carried.includes('KXTRUMPRUN-28NOV07'));
  assert.equal(snap.ends.pct, 89.6);
  // batch AND singles 429, no relay → carried map, ok:false, error names both failures
  calls = []; mockFetch(calls, { '/markets?tickers=': () => new Response('rate limited', { status: 429 }), '/trade-api/v2/markets/KX': () => new Response('rate limited', { status: 429 }) });
  ({ snap } = await refresh({ STATE }, { schedule: true, now: NOW + 1200e3 }));
  assert.equal(snap.sources.kalshi.ok, false); assert.match(snap.sources.kalshi.error, /^HTTP 429 \(batch\); HTTP 429 \(per-ticker\)/);
  assert.equal(calls.filter((u) => /\/trade-api\/v2\/markets\/KX/.test(u)).length, 72);   // cron is patient: 4 attempts per ticker on 429
  assert.equal(calls[calls.findIndex((u) => /\/trade-api\/v2\/markets\/KX/.test(u))].split('/markets/')[1], 'KXTRUMPOUT27-27-JAN2029');   // headline ticker first
  assert.equal(snap.ends.pct, 89.6); assert.equal(Object.keys(snap.markets.kalshi).length, 16);
  // a 404 on the batch also falls through to singles (one batch call only)
  calls = []; mockFetch(calls, { '/markets?tickers=': () => new Response('nope', { status: 404 }), '/trade-api/v2/markets/KX': single });
  ({ snap } = await refresh({ STATE }, { schedule: true, now: NOW + 1800e3 }));
  assert.equal(calls.filter((u) => u.includes('/markets?tickers=')).length, 1); assert.equal(snap.sources.kalshi.via, 'singles');
  // a fresh relay document (written by the GitHub Actions workflow) is used when the direct call fails
  const fetchedAt = new Date(NOW + 2400e3 - 10 * 60e3).toISOString();
  await STATE.put('kalshi', JSON.stringify({ fetchedAt, batch: JSON.parse(fx('k_batch.json')), election2028: JSON.parse(fx('k2028.json')) }));
  calls = []; mockFetch(calls, { '/markets?tickers=': () => new Response('rate limited', { status: 429 }), '/trade-api/v2/markets/KX': () => new Response('rate limited', { status: 429 }), 'event_ticker=KXPRESPERSON-28': () => new Response('rate limited', { status: 429 }), '/events/KXPRESPERSON-28': () => new Response('rate limited', { status: 429 }) });
  ({ snap } = await refresh({ STATE }, { job: 'election2028', now: NOW + 2400e3 }));
  assert.equal(snap.sources.kalshi.ok, true); assert.equal(snap.sources.kalshi.via, 'relay'); assert.equal(snap.sources.kalshi.at, fetchedAt);
  assert.match(snap.sources.kalshi.error, /direct fetch failed \(HTTP 429 .*\); values via the relay/);
  assert.equal(snap.ends.pct, 89.6); assert.equal(snap.stale, false);
  assert.ok(Object.values(snap.markets.kalshi).every((r) => r.carried === false && r.at === fetchedAt));
  assert.equal(snap.election2028.kalshi.length, 20);        // the 2028 leg came from the relay too
  assert.ok(snap.groups.election2028.some((x) => x.label === 'J.D. Vance' && x.byVenue.Kalshi));
  // a stale relay is ignored and named in the error
  await STATE.put('kalshi', JSON.stringify({ fetchedAt: new Date(NOW - 3600e3).toISOString(), batch: JSON.parse(fx('k_batch.json')) }));
  ({ snap } = await refresh({ STATE }, { schedule: true, now: NOW + 3000e3 }));
  assert.equal(snap.sources.kalshi.ok, false); assert.match(snap.sources.kalshi.error, /HTTP 429 .*; relay stale \(110m old\)/);
  assert.equal(snap.ends.pct, 89.6);
  // with the secrets set, Kalshi requests carry the three signed headers (keyless otherwise)
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const seen = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => { if (String(url).includes('kalshi.com')) seen.push(init.headers); return orig(url, init); };
  await refresh({ STATE, KALSHI_KEY_ID: 'kid', KALSHI_PRIVATE_KEY: pem }, { schedule: true, now: NOW + 3600e3 });
  assert.ok(seen.length >= 1);
  assert.equal(seen[0]['KALSHI-ACCESS-KEY'], 'kid'); assert.match(seen[0]['KALSHI-ACCESS-TIMESTAMP'], /^\d{13}$/); assert.match(seen[0]['KALSHI-ACCESS-SIGNATURE'], /^[A-Za-z0-9+/]+=*$/);
  assert.equal(seen[0].origin, undefined);
  seen.length = 0;
  await refresh({ STATE }, { schedule: true, now: NOW + 3600e3 });
  assert.equal(seen[0]['KALSHI-ACCESS-KEY'], undefined);
});

test('KV put failure never throws out of refresh()', async () => {
  const calls = []; mockFetch(calls);
  const STATE = kv(); STATE.put = async () => { throw new Error('KV PUT failed: 429'); };
  const orig = console.error; const errs = []; console.error = (...a) => errs.push(a.join(' '));
  try {
    const { snap } = await refresh({ STATE }, { now: NOW });
    assert.equal(snap.ends.pct, 89.6);
    assert.ok(errs.some((e) => /kv put snapshot/.test(e)));
  } finally { console.error = orig; }
});
