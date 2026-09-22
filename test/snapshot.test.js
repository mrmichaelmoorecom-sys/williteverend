import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseKalshiBatch, parsePolymarketKeyset, parsePolymarketMarket } from '../src/lib/markets.js';
import { computeEnds, computeEarly, computeVerdict, computeApproval, buildSnapshot, buildGroups, venueMean, K, PM } from '../src/lib/snapshot.js';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
const NOW = Date.parse('2026-09-22T06:30:00Z');

function live() {
  const kalshi = parseKalshiBatch(fx('k_batch.json'));
  const polymarket = parsePolymarketKeyset(fx('pm_keyset.json'));
  for (const f of ['pm_win2028.json', 'pm_nom2028.json']) { const m = parsePolymarketMarket(fx(f)); polymarket[m.id] = m; }
  return { kalshi, polymarket };
}
const row = (prob, extra = {}) => ({ prob, venue: 'Kalshi', thin: false, ...extra });

test('§1.6 headline with the spec numbers → 89.6%', () => {
  const kalshi = { [K.WIN2028]: row(0.027), [K.OCCUR2028]: row(0.917) };
  const polymarket = { [PM.WIN2028]: { prob: 0.0145, venue: 'Polymarket', thin: false } };
  const e = computeEnds({ kalshi, polymarket });
  assert.equal(e.pct, 89.6);
  assert.equal(e.inputs.p_win2028, 0.0208);          // mean(0.027, 0.0145) = 0.02075 rounded to 4dp
  assert.equal(e.inputs.p_noelect, 0.083);
  assert.equal(e.inputs.p_stays, 0.1038);
  assert.deepEqual(e.venues, ['Kalshi', 'Polymarket']);
  assert.equal(e.partial, false);
});

test('§1.6 headline from the live fixtures also → 89.6%', () => {
  const e = computeEnds(live());
  assert.equal(e.pct, 89.6);
});

test('§1.6 fallbacks: Kalshi down → 98.6% (Polymarket only); Polymarket down → 89.0% (Kalshi only); both down → null', () => {
  const kalshi = { [K.WIN2028]: row(0.027), [K.OCCUR2028]: row(0.917) };
  const polymarket = { [PM.WIN2028]: { prob: 0.0145, venue: 'Polymarket', thin: false } };
  const a = computeEnds({ kalshi: {}, polymarket });
  assert.equal(a.pct, 98.6); assert.deepEqual(a.venues, ['Polymarket']); assert.equal(a.partial, true);
  const b = computeEnds({ kalshi, polymarket: {} });
  assert.equal(b.pct, 89); assert.deepEqual(b.venues, ['Kalshi']);
  assert.equal(computeEnds({ kalshi: {}, polymarket: {} }).pct, null);
});

test('thin-market gating: a thin venue is ignored when the other is solid, used when both are thin', () => {
  const solid = { prob: 0.02, venue: 'Kalshi', thin: false }, thin = { prob: 0.5, venue: 'Polymarket', thin: true };
  assert.deepEqual(venueMean([solid, thin]), { value: 0.02, venues: ['Kalshi'], thin: false });
  assert.deepEqual(venueMean([{ ...solid, thin: true }, thin]), { value: 0.26, venues: ['Kalshi', 'Polymarket'], thin: true });
  assert.equal(venueMean([]).value, null);
});

test('§1.7 ends-early = max of nested legs (never sum) → 23.5%; expectEarly false', () => {
  const kalshi = { [K.OUT_JAN2029]: row(0.235), [K.RESIGN]: row(0.235), [K.REMOVE]: row(0.17), [K.AMEND25]: row(0.16) };
  const e = computeEarly({ kalshi, now: NOW });
  assert.equal(e.pct, 23.5);
  assert.equal(e.expectEarly, false);
  const mis = computeEarly({ kalshi: { ...kalshi, [K.REMOVE]: row(0.3) }, now: NOW });
  assert.equal(mis.pct, 30);   // a mispriced leg above the umbrella wins (max)
  assert.equal(computeEarly({ kalshi: {}, now: NOW }).pct, null);
});

test('§1.7 live fixtures: 23.5%, before-2027 cross-check 4.8%, hazard model ≈ 37.9% (never headline)', () => {
  const e = computeEarly({ ...live(), now: NOW, termEnd: '2029-01-20T17:00:00Z' });
  assert.equal(e.pct, 23.5);
  assert.equal(e.before2027.pct, 4.8);      // mean(0.055, 0.0405) = 0.04775
  assert.ok(e.model && Math.abs(e.model.pct - 37.9) < 0.6, `model ${e.model && e.model.pct}`);
  assert.equal(e.expectEarly, false);
});

test('expectEarly when any Group-1 market ≥ 0.5', () => {
  const e = computeEarly({ kalshi: { [K.OUT_JAN2029]: row(0.55) }, now: NOW });
  assert.equal(e.expectEarly, true);
});

test('§1.8 verdict: NO by default; YES when the term end passes', () => {
  const l = live();
  assert.equal(computeVerdict({ now: NOW, ...l }).verdict, 'NO');
  const v = computeVerdict({ now: Date.parse('2029-01-20T17:00:00Z'), ...l });
  assert.equal(v.verdict, 'YES'); assert.equal(v.endedAt, '2029-01-20T17:00:00Z');
  assert.equal(computeVerdict({ now: Date.parse('2029-01-20T16:59:59Z'), ...l }).verdict, 'NO');
});

test('§1.8 verdict: Kalshi finalized YES on umbrella/remove/resign flips; AMEND25/IMPEACH do not', () => {
  const l = live();
  const fin = (t) => ({ ...l, kalshi: { ...l.kalshi, [t]: { ...l.kalshi[t], status: 'finalized', result: 'yes' } } });
  for (const t of [K.OUT_JAN2029, K.REMOVE, K.RESIGN]) assert.equal(computeVerdict({ now: NOW, ...fin(t) }).verdict, 'YES', t);
  for (const t of [K.AMEND25, K.IMPEACH_29, K.IMPEACH_28]) assert.equal(computeVerdict({ now: NOW, ...fin(t) }).verdict, 'NO', t);
  // finalized NO does not flip
  const no = { ...l, kalshi: { ...l.kalshi, [K.OUT_JAN2029]: { ...l.kalshi[K.OUT_JAN2029], status: 'finalized', result: 'no' } } };
  assert.equal(computeVerdict({ now: NOW, ...no }).verdict, 'NO');
});

test('§1.8 verdict: Polymarket closed at 1 flips (before-2027 or the monthly market); closed at 0 does not', () => {
  const l = live();
  const yes = { ...l, polymarket: { ...l.polymarket, [PM.OUT_2027]: { ...l.polymarket[PM.OUT_2027], closed: true, resolvedYes: true } } };
  assert.equal(computeVerdict({ now: NOW, ...yes }).verdict, 'YES');
  const no = { ...l, polymarket: { ...l.polymarket, [PM.OUT_2027]: { ...l.polymarket[PM.OUT_2027], closed: true, resolvedYes: false } } };
  assert.equal(computeVerdict({ now: NOW, ...no }).verdict, 'NO');
  const monthly = { id: 'dtrump-out-as-president-by-september-30', closed: true, resolvedYes: true, endDate: '2026-10-01T03:59:00Z' };
  assert.equal(computeVerdict({ now: NOW, ...l, monthly }).verdict, 'YES');
});

test('§1.8 overrides: config > KV > computed; NO override blocks the date rule', () => {
  const l = live();
  assert.equal(computeVerdict({ now: NOW, ...l, kvOverride: 'YES' }).verdict, 'YES');
  assert.equal(computeVerdict({ now: NOW, ...l, kvOverride: 'yes' }).verdict, 'YES');
  assert.equal(computeVerdict({ now: NOW, ...l, override: 'NO', kvOverride: 'YES' }).verdict, 'NO');
  assert.equal(computeVerdict({ now: NOW, ...l, override: 'YES' }).verdict, 'YES');
  assert.equal(computeVerdict({ now: Date.parse('2030-01-01T00:00:00Z'), ...l, kvOverride: 'NO' }).verdict, 'NO');
  assert.equal(computeVerdict({ now: NOW, ...l, override: 'garbage', kvOverride: null }).verdict, 'NO');
});

test('§2 approval mean of NYT + Silver Bulletin → 38.2 / 59.1 / −20.9; stale source rejected', () => {
  const a = computeApproval({ nyt: { approve: 37.8, disapprove: 59.3, date: '2026-09-22' }, sb: { approve: 38.59664, disapprove: 58.8613, date: '2026-09-21' }, now: NOW });
  assert.equal(a.approve, 38.2); assert.equal(a.disapprove, 59.1); assert.equal(a.net, -20.9);
  assert.equal(a.partial, false);
  const stale = computeApproval({ nyt: { approve: 37.8, disapprove: 59.3, date: '2026-09-22' }, sb: { approve: 50, disapprove: 40, date: '2026-09-01' }, now: NOW });
  assert.equal(stale.approve, 37.8); assert.equal(stale.partial, true);
  assert.equal(stale.sources.find((s) => s.key === 'sb').ok, false);
  const none = computeApproval({ now: NOW });
  assert.equal(none.approve, null); assert.equal(none.net, null);
});

test('buildGroups: rows carry label/pct/venue/link/thin; derived not-occur row; empty when no data', () => {
  const g = buildGroups(live());
  assert.ok(g.early.length >= 12);
  const primary = g.early.find((r) => r.primary);
  assert.equal(primary.id, K.OUT_JAN2029); assert.equal(primary.pct, 23.5); assert.equal(primary.venue, 'Kalshi');
  const notOccur = g.stays.find((r) => r.id === K.OCCUR2028);
  assert.equal(notOccur.pct, 8.3); assert.equal(notOccur.label, '2028 election does not occur');
  assert.ok(g.stays.find((r) => r.id === K.RUN2028).thin);
  assert.equal(g.approval.length, 1);   // KXTRUMPAPPROVALBELOW-26DEC31-37 isn't in the batch fixture; PM hit-35 is
  assert.ok(g.election2028.find((r) => r.id === K.PARTY_D));
  const empty = buildGroups({});
  assert.deepEqual(empty, { early: [], stays: [], approval: [], election2028: [] });
});

test('buildSnapshot: full shape, source flags, carry-forward of a failed source', () => {
  const l = live();
  const config = { termEnd: '2029-01-20T17:00:00Z', override: null, president: { name: 'Donald J. Trump' }, links: { github: 'g' } };
  const snap = buildSnapshot({ now: NOW, config, kalshi: { ok: true, markets: l.kalshi, at: '2026-09-22T06:29:00Z' }, polymarket: { ok: true, markets: l.polymarket, at: '2026-09-22T06:29:00Z' } });
  assert.equal(snap.verdict, 'NO');
  assert.equal(snap.daysLeft, 851);
  assert.equal(snap.ends.pct, 89.6);
  assert.equal(snap.early.pct, 23.5);
  assert.equal(snap.sources.kalshi.ok, true);
  assert.equal(snap.config.president.name, 'Donald J. Trump');
  assert.equal(snap.updatedAt, '2026-09-22T06:30:00.000Z');
  // Kalshi fails next run: markets carried forward from prev, ok=false, headline unchanged
  const snap2 = buildSnapshot({ now: NOW + 600e3, config, prev: snap,
    kalshi: { ok: false, markets: snap.markets.kalshi, at: snap.sources.kalshi.at, error: 'HTTP 503' },
    polymarket: { ok: true, markets: l.polymarket, at: '2026-09-22T06:39:00Z' } });
  assert.equal(snap2.ends.pct, 89.6);
  assert.equal(snap2.sources.kalshi.ok, false);
  assert.equal(snap2.sources.kalshi.error, 'HTTP 503');
  assert.equal(snap2.sources.kalshi.at, '2026-09-22T06:29:00Z');
  // config override wins
  const snap3 = buildSnapshot({ now: NOW, config: { ...config, override: 'YES' }, kvOverride: 'NO', kalshi: { ok: true, markets: l.kalshi }, polymarket: { ok: true, markets: l.polymarket } });
  assert.equal(snap3.verdict, 'YES');
  const snap4 = buildSnapshot({ now: NOW + 86400e3, config: { ...config, override: 'YES' }, prev: snap3, kalshi: { ok: true, markets: l.kalshi }, polymarket: { ok: true, markets: l.polymarket } });
  assert.equal(snap4.endedAt, snap3.endedAt);   // sticky endedAt
  // nothing at all: still a NO with a countdown and null headline
  const bare = buildSnapshot({ now: NOW, config });
  assert.equal(bare.verdict, 'NO'); assert.equal(bare.ends.pct, null); assert.equal(bare.daysLeft, 851);
});
