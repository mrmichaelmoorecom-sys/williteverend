// Integration: the Worker's refresh()/scheduled() against a mocked fetch + Map-backed KV.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const keyset = JSON.parse(fx('pm_keyset.json'));
const monthlyEvent = keyset.events.find((e) => e.slug === 'dtrump-out-as-president-by-september-30');
const future = new Date(Date.now() + 20 * 86400e3).toISOString();

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
    if (u.endsWith('/kSCt4/')) return text('<meta http-equiv="REFRESH" content="0; url=https://datawrapper.dwcdn.net/kSCt4/7832/">', 'text/html');
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

test('cold start (empty KV): light refresh only — no approval/news/2028 fetches — and snapshot is written', async () => {
  const calls = []; mockFetch(calls);
  const STATE = kv();
  const { snap, news, job } = await refresh({ STATE });
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
  assert.equal(snap.sources.polymarket.partial, false);
});

test('scheduled ticks: one heavy job per tick, approval → election2028 → news, each persisted', async () => {
  const STATE = kv();
  let calls = []; mockFetch(calls);
  await refresh({ STATE });                                   // cold start
  calls.length = 0;
  let r = await refresh({ STATE }, { schedule: true });
  assert.equal(r.job, 'approval');
  assert.ok(calls.some((u) => u.includes('president-averages')) && calls.some((u) => u.includes('dataset.csv')));
  assert.ok(!calls.some((u) => u.includes('news.google') || u.includes('event_ticker=KXPRESPERSON-28')));
  assert.equal(r.snap.approval.sources.length, 2);
  assert.ok(r.snap.jobs.approval);
  const snapKv = JSON.parse(STATE.m.get('snapshot'));
  assert.equal(snapKv.approval.approve, r.snap.approval.approve);

  calls.length = 0;
  r = await refresh({ STATE }, { schedule: true });
  assert.equal(r.job, 'election2028');
  assert.ok(calls.some((u) => u.includes('event_ticker=KXPRESPERSON-28')) && calls.some((u) => u.includes('presidential-election-winner-2028')));
  assert.ok(calls.some((u) => u.includes('title_search=')), 'discovery rides with the 2028 job');
  assert.ok(!calls.some((u) => u.includes('president-averages') || u.includes('news.google')));
  assert.ok(r.snap.election2028.kalshi.length && r.snap.election2028.polymarket.length);
  const people = r.snap.groups.election2028.filter((x) => x.byVenue);
  assert.ok(people.length >= 5 && people.length <= 8);
  assert.ok(people.some((x) => x.label === 'J.D. Vance' && x.byVenue.Kalshi && x.byVenue.Polymarket), 'Vance merged across venues');

  calls.length = 0;
  r = await refresh({ STATE }, { schedule: true });
  assert.equal(r.job, 'news');
  assert.equal(calls.filter((u) => /theguardian|politico|thehill|news\.google/.test(u)).length, 4);
  assert.ok(r.news && r.news.items.length >= 30);
  assert.ok(STATE.m.has('news'));
  assert.equal(r.snap.sources.news.ok, true);
  assert.ok(r.news.items.every((it) => /^https?:\/\//.test(it.link)));

  // everything fresh → markets only
  calls.length = 0;
  r = await refresh({ STATE }, { schedule: true });
  assert.equal(r.job, null);
  assert.deepEqual(heavyCalls(calls), []);
  assert.ok(!calls.some((u) => u.includes('title_search=')), 'no rediscovery while the monthly slug is valid');

  // scheduled() with a forced job name (local `?cron=news`)
  calls.length = 0;
  await worker.default.scheduled({ cron: 'news' }, { STATE }, { waitUntil() {} });
  assert.equal(calls.filter((u) => /theguardian|politico|thehill|news\.google/.test(u)).length, 4);
  calls.length = 0;
  await worker.default.scheduled({ cron: '*/10 * * * *' }, { STATE }, { waitUntil() {} });
  assert.deepEqual(heavyCalls(calls), []);
});

test('a 200 with an empty Kalshi list keeps the previous good map, ok=false, updatedAt frozen', async () => {
  const STATE = kv();
  const calls = []; mockFetch(calls);
  const first = (await refresh({ STATE })).snap;
  mockFetch(calls, { '/markets?tickers=': () => new Response('{"cursor":"","markets":[]}', { status: 200, headers: { 'content-type': 'application/json' } }) });
  const { snap } = await refresh({ STATE }, { schedule: true });
  assert.equal(snap.sources.kalshi.ok, false);
  assert.match(snap.sources.kalshi.error, /0 markets/);
  assert.equal(snap.sources.kalshi.at, first.sources.kalshi.at);
  assert.equal(Object.keys(snap.markets.kalshi).length, 16);
  assert.equal(snap.ends.pct, 89.6);
  assert.deepEqual(snap.ends.venues, ['Kalshi', 'Polymarket']);
  assert.equal(snap.stale, false);                            // Polymarket was fresh
  // both venues empty → carried snapshot keeps its old updatedAt and is flagged stale
  mockFetch(calls, {
    '/markets?tickers=': () => new Response('{"cursor":"","markets":[]}', { status: 200 }),
    '/events/keyset?slug=': () => new Response('{"events":[]}', { status: 200 }),
  });
  const { snap: both } = await refresh({ STATE }, { schedule: true });
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
  let { snap } = await refresh({ STATE });
  assert.equal(snap.sources.kalshi.ok, false);
  assert.match(snap.sources.kalshi.error, /only 8\/18 tickers/);
  assert.deepEqual(snap.markets.kalshi, {});                  // nothing to carry on a cold start
  mockFetch(calls, { '/markets/slug/will-donald-trump-win-the-2028-us': () => new Response('{"type":"not found error"}', { status: 404 }) });
  ({ snap } = await refresh({ STATE }, { schedule: true }));
  assert.equal(snap.sources.polymarket.ok, true);
  assert.equal(snap.sources.polymarket.partial, true);
  assert.deepEqual(snap.sources.polymarket.missing, ['will-donald-trump-win-the-2028-us-presidential-election']);
  assert.match(snap.sources.polymarket.error, /HTTP 404/);
  assert.equal(snap.ends.pct, 89);                            // Kalshi-only headline, tagged
  assert.deepEqual(snap.ends.venues, ['Kalshi']);
});

test('KV put failure never throws out of refresh()', async () => {
  const calls = []; mockFetch(calls);
  const STATE = kv(); STATE.put = async () => { throw new Error('KV PUT failed: 429'); };
  const orig = console.error; const errs = []; console.error = (...a) => errs.push(a.join(' '));
  try {
    const { snap } = await refresh({ STATE });
    assert.equal(snap.ends.pct, 89.6);
    assert.ok(errs.some((e) => /kv put snapshot/.test(e)));
  } finally { console.error = orig; }
});
