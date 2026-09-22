import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseKalshiBatch, parsePolymarketKeyset, parsePolymarketMarket, parsePolymarket2028, kalshiLink, pmYes, pickMonthlyOutEvent, polymarketRow } from '../src/lib/markets.js';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));

test('Kalshi batch: dollar strings → mid, thin flag by spread, links, status/result', () => {
  const k = parseKalshiBatch(fx('k_batch.json'));
  assert.equal(Object.keys(k).length, 16);
  const out = k['KXTRUMPOUT27-27-JAN2029'];
  assert.equal(out.prob, 0.235);
  assert.equal(out.bid, 0.23); assert.equal(out.ask, 0.24); assert.equal(out.last, 0.24);
  assert.equal(out.volume, 566837.81);
  assert.equal(out.thin, false);
  assert.equal(out.status, 'active'); assert.equal(out.result, ''); assert.equal(out.closed, false);
  assert.equal(out.link, 'https://kalshi.com/markets/kxtrumpout27/x/kxtrumpout27-27');
  assert.equal(out.venue, 'Kalshi');
  assert.equal(k['KXTRUMPRUN-28NOV07'].thin, true);           // 0.14 / 0.22
  assert.equal(k['KXTRUMPRUN-28NOV07'].prob, 0.18);
  assert.equal(k['KXPRESELECTIONOCCUR-28'].prob, 0.917);
  assert.equal(k['KXPRESPERSON-28-DTRU'].prob, 0.027);
  assert.equal(k['KXTRUMPRESIGN'].link, 'https://kalshi.com/markets/kxtrumpresign/x/kxtrumpresign');
});

test('Kalshi single-market shape and missing prices', () => {
  const k = parseKalshiBatch({ market: { ticker: 'X', event_ticker: 'X-1', last_price_dollars: '0.5000', status: 'finalized', result: 'yes' } });
  assert.equal(k.X.prob, 0.5); assert.equal(k.X.closed, true); assert.equal(k.X.result, 'yes');
  assert.throws(() => parseKalshiBatch({}), /no markets/);
});

test('Polymarket keyset: JSON-string outcomePrices, liquidity/spread gating, resolved-yes detection', () => {
  const p = parsePolymarketKeyset(fx('pm_keyset.json'));
  const out = p['trump-out-as-president-before-2027'];
  assert.equal(out.prob, 0.055);
  assert.equal(out.bid, 0.05); assert.equal(out.ask, 0.06);
  assert.equal(out.thin, false);
  assert.equal(out.closed, false); assert.equal(out.resolvedYes, false);
  assert.equal(out.link, 'https://polymarket.com/event/trump-out-as-president-before-2027');
  assert.equal(out.embed, 'https://embed.polymarket.com/market?market=trump-out-as-president-before-2027&theme=light&buttons=false');
  assert.equal(out.endDate, '2027-01-01T04:59:00Z');
  assert.equal(p['will-trump-be-impeached-by-december-31-2027'].thin, true);   // bid .52 ask .89 vol $825
  assert.equal(p['will-trump-be-impeached-before-his-term-ends'].prob, 0.685);
  const hit40 = p['will-trumps-approval-rating-hit-40-in-2026'];
  assert.equal(hit40.closed, true); assert.equal(hit40.resolvedYes, true); assert.equal(hit40.prob, 1);
  assert.equal(p['dtrump-out-as-president-by-september-30'].prob, 0.0015);
});

test('Polymarket single market objects (2028 lines)', () => {
  const w = parsePolymarketMarket(fx('pm_win2028.json'));
  assert.equal(w.id, 'will-donald-trump-win-the-2028-us-presidential-election');
  assert.equal(w.prob, 0.0145); assert.equal(w.thin, false);
  const n = parsePolymarketMarket(fx('pm_nom2028.json'));
  assert.equal(n.prob, 0.0205);
});

test('pmYes: string array, real array, fallback to lastTradePrice', () => {
  assert.equal(pmYes({ outcomePrices: '["0.055", "0.945"]' }), 0.055);
  assert.equal(pmYes({ outcomePrices: ['0.3', '0.7'] }), 0.3);
  assert.equal(pmYes({ lastTradePrice: 0.12 }), 0.12);
  assert.equal(pmYes({}), null);
  assert.equal(polymarketRow({ slug: 's', lastTradePrice: null }).prob, null);
});

test('Polymarket 2028 event: skips placeholders, names from groupItemTitle, sorted', () => {
  const rows = parsePolymarket2028(fx('pm_ev2028.json'), 5);
  assert.equal(rows.length, 5);
  assert.equal(rows[0].label, 'JD Vance'); assert.equal(rows[0].prob, 0.2065);
  assert.ok(rows.every((r, i) => i === 0 || rows[i - 1].prob >= r.prob));
  assert.ok(rows.every((r) => !/^will-/.test(r.label)));
  assert.throws(() => parsePolymarket2028({}), /no markets/);
});

test('monthly out-by market discovery: slug regex + future endDate, earliest first, excludes before-2027 + Harp', () => {
  const now = Date.parse('2026-09-22T06:00:00Z');
  const j = { events: [
    { slug: 'natalie-harp-out-as-special-assistant-to-the-president-by-december-31', endDate: '2027-01-01T04:59:00Z' },
    { slug: 'trump-out-as-president-before-2027', endDate: '2027-01-01T04:59:00Z' },
    { slug: 'dtrump-out-as-president-by-september-30', endDate: '2026-10-01T03:59:00Z' },
    { slug: 'trump-out-as-president-by-october-31-123', endDate: '2026-11-01T03:59:00Z' },
    { slug: 'trump-out-as-president-by-august-31', endDate: '2026-09-01T03:59:00Z' },
  ] };
  assert.equal(pickMonthlyOutEvent(j, now), 'dtrump-out-as-president-by-september-30');
  assert.equal(pickMonthlyOutEvent(j, Date.parse('2026-10-02T00:00:00Z')), 'trump-out-as-president-by-october-31-123');
  assert.equal(pickMonthlyOutEvent(j, Date.parse('2026-12-02T00:00:00Z')), null);
  assert.equal(pickMonthlyOutEvent({}), null);
});

test('kalshiLink lowercases series/event', () => {
  assert.equal(kalshiLink({ event_ticker: 'KXPRESPERSON-28' }), 'https://kalshi.com/markets/kxpresperson/x/kxpresperson-28');
});
