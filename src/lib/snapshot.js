// Snapshot math: headline formulas (§1.6, §1.7), verdict rule (§1.8), row grouping, approval mean (§2).

export const TERM_END_DEFAULT = '2029-01-20T17:00:00Z';

// Kalshi tickers (verbatim from the spec).
export const K = {
  OUT_JAN2029: 'KXTRUMPOUT27-27-JAN2029', OUT_28: 'KXTRUMPOUT27-27-28', OUT_27: 'KXTRUMPOUT27-27-DJT',
  REMOVE: 'KXTRUMPREMOVE', RESIGN: 'KXTRUMPRESIGN', IMPEACH_29: 'KXIMPEACH-29-JAN20', IMPEACH_28: 'KXIMPEACH-28-JAN01',
  AMEND25: 'KXAMEND25-29', WIN2028: 'KXPRESPERSON-28-DTRU', NOM2028: 'KXPRESNOMR-28-DJT', RUN2028: 'KXTRUMPRUN-28NOV07',
  OCCUR2028: 'KXPRESELECTIONOCCUR-28', PARTY_D: 'KXPRESPARTY-2028-D', PARTY_R: 'KXPRESPARTY-2028-R',
  MARTIAL: 'KXMARTIAL-29JAN20', INSURRECTION: 'KXINSURRECTION-29',
  FAMILY2028: 'KXTRUMPPRES-28', APPROVAL_BELOW_37: 'KXTRUMPAPPROVALBELOW-26DEC31-37',
};
export const KALSHI_TICKERS = Object.values(K);

// Polymarket market slugs (verbatim from the spec).
export const PM = {
  OUT_2027: 'trump-out-as-president-before-2027',
  RESIGN_2026: 'will-trump-resign-by-december-31-2026',
  AMEND25_2027: 'trump-removed-via-25th-amendment-before-2027',
  IMPEACH_2026: 'will-trump-be-impeached-by-december-31-2026',
  IMPEACH_TERM: 'will-trump-be-impeached-before-his-term-ends',
  TERM_LIMITS: 'will-trump-repeal-presidential-term-limits-in-2026',
  APPROVAL_35: 'will-trumps-approval-rating-hit-35-in-2026',
  WIN2028: 'will-donald-trump-win-the-2028-us-presidential-election',
  NOM2028: 'will-donald-trump-win-the-2028-republican-presidential-nomination',
};
// Event slugs for the keyset call (the approval one wraps several markets).
export const PM_KEYSET_EVENTS = [
  'trump-out-as-president-before-2027', 'will-trump-be-impeached-by-december-31-2026', 'will-trump-resign-by-december-31-2026',
  'trump-removed-via-25th-amendment-before-2027', 'how-low-will-trumps-approval-rating-go-in-2026',
  'will-trump-be-impeached-before-his-term-ends', 'will-trump-repeal-presidential-term-limits-in-2026',
];

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const r1 = (x) => (x == null ? null : Math.round(x * 1000) / 10);        // 0.89625 → 89.6
const r4 = (x) => (x == null ? null : Math.round(x * 1e4) / 1e4);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** A usable market probability: exists and has a number. `thin` rows are usable only when nothing else is. */
function pick(row) { return row && row.prob != null ? row : null; }

/**
 * Mean across venues of the same question: prefer non-thin rows; if every venue is thin use them all;
 * returns { value, venues: [names], thin }.
 */
export function venueMean(rows) {
  const have = rows.filter(pick);
  const solid = have.filter((r) => !r.thin);
  const use = solid.length ? solid : have;
  return { value: mean(use.map((r) => r.prob)), venues: use.map((r) => r.venue), thin: !solid.length && have.length > 0 };
}

/** §1.6 — chance the term ends on or before Jan 20 2029. */
export function computeEnds({ kalshi = {}, polymarket = {} }) {
  const kWin = pick(kalshi[K.WIN2028]), pmWin = pick(polymarket[PM.WIN2028]);
  const win = venueMean([kWin, pmWin].filter(Boolean));
  const occur = pick(kalshi[K.OCCUR2028]);
  const pNoElect = occur ? r4(1 - occur.prob) : null;
  if (win.value == null && pNoElect == null) return { pct: null, inputs: {}, venues: [] };
  const pStays = clamp01((win.value ?? 0) + (pNoElect ?? 0));
  const venues = [...new Set([...win.venues, ...(occur ? ['Kalshi'] : [])])];
  return {
    pct: r1(1 - pStays),
    inputs: {
      k_win2028: kWin ? kWin.prob : null, pm_win2028: pmWin ? pmWin.prob : null,
      p_win2028: r4(win.value), p_noelect: pNoElect, p_stays: r4(pStays),
    },
    venues, partial: venues.length < 2,
  };
}

/** §1.7 — chance it ends early: max (not sum) of the nested Kalshi early-exit markets. */
export function computeEarly({ kalshi = {}, polymarket = {}, monthly = null, now = Date.now(), termEnd = TERM_END_DEFAULT }) {
  const legs = [K.OUT_JAN2029, K.RESIGN, K.REMOVE, K.AMEND25].map((t) => pick(kalshi[t])).filter(Boolean);
  const pEarly = legs.length ? Math.max(...legs.map((r) => r.prob)) : null;
  const before2027 = venueMean([pick(polymarket[PM.OUT_2027]), pick(kalshi[K.OUT_27])].filter(Boolean));
  // Optional model row: hazard extrapolation from the before-2027 market. Never the headline.
  let model = null;
  const pm27 = pick(polymarket[PM.OUT_2027]);
  if (pm27 && pm27.endDate && pm27.prob > 0 && pm27.prob < 1) {
    const dLeft = (Date.parse(termEnd) - now) / 86400e3, d27 = (Date.parse(pm27.endDate) - now) / 86400e3;
    if (dLeft > 0 && d27 > 0) model = { pct: r1(1 - Math.pow(1 - pm27.prob, dLeft / d27)), basis: PM.OUT_2027 };
  }
  const anyHigh = [K.OUT_JAN2029, K.OUT_28, K.OUT_27, K.RESIGN, K.REMOVE, K.AMEND25].some((t) => kalshi[t] && kalshi[t].prob >= 0.5)
    || [PM.OUT_2027, PM.RESIGN_2026, PM.AMEND25_2027].some((s) => polymarket[s] && polymarket[s].prob >= 0.5)
    || (monthly && monthly.prob >= 0.5);
  return {
    pct: r1(pEarly),
    inputs: Object.fromEntries(legs.map((r) => [r.id, r.prob])),
    before2027: { pct: r1(before2027.value), venues: before2027.venues },
    model,
    expectEarly: (pEarly != null && pEarly >= 0.5) || !!anyHigh,
  };
}

/** §1.8 — NO → YES. config override > KV override > computed. Returns { verdict, reason, endedAt }. */
export function computeVerdict({ now = Date.now(), termEnd = TERM_END_DEFAULT, override = null, kvOverride = null, kalshi = {}, polymarket = {}, monthly = null }) {
  const ov = (v) => (typeof v === 'string' && /^(yes|no)$/i.test(v.trim()) ? v.trim().toUpperCase() : null);
  const cfg = ov(override), kv = ov(kvOverride);
  if (cfg) return { verdict: cfg, reason: `config override (${cfg})`, endedAt: cfg === 'YES' ? new Date(now).toISOString() : null };
  if (kv) return { verdict: kv, reason: `manual override (${kv})`, endedAt: kv === 'YES' ? new Date(now).toISOString() : null };
  if (now >= Date.parse(termEnd)) return { verdict: 'YES', reason: 'term ended on schedule', endedAt: termEnd };
  for (const t of [K.OUT_JAN2029, K.REMOVE, K.RESIGN]) {
    const r = kalshi[t];
    if (r && r.status === 'finalized' && String(r.result).toLowerCase() === 'yes') return { verdict: 'YES', reason: `Kalshi ${t} settled YES`, endedAt: r.updatedAt || new Date(now).toISOString() };
  }
  for (const r of [polymarket[PM.OUT_2027], monthly]) {
    if (r && r.closed && r.resolvedYes) return { verdict: 'YES', reason: `Polymarket ${r.id} resolved YES`, endedAt: r.endDate || new Date(now).toISOString() };
  }
  return { verdict: 'NO', reason: 'no settled exit market; term end not reached', endedAt: null };
}

/** §2 — mean of the two primaries; reject a primary older than 7 days. */
export function computeApproval({ nyt = null, sb = null, now = Date.now() } = {}) {
  const fresh = (s) => s && Number.isFinite(s.approve) && Number.isFinite(s.disapprove) && s.date && now - Date.parse(s.date) <= 7 * 86400e3 + 12 * 3600e3;
  const sources = [
    { key: 'nyt', name: 'NYT polling average', link: 'https://www.nytimes.com/interactive/polls/donald-trump-approval-rating-polls.html', ...(nyt || {}), ok: fresh(nyt) },
    { key: 'sb', name: 'Silver Bulletin', link: 'https://www.natesilver.net/p/trump-approval-ratings-nate-silver-bulletin', ...(sb || {}), ok: fresh(sb) },
  ];
  const use = sources.filter((s) => s.ok);
  const approve = use.length ? Math.round(mean(use.map((s) => s.approve)) * 10) / 10 : null;
  const disapprove = use.length ? Math.round(mean(use.map((s) => s.disapprove)) * 10) / 10 : null;
  const net = approve != null ? Math.round((approve - disapprove) * 10) / 10 : null;
  return { approve, disapprove, net, sources, partial: use.length === 1 };
}

const pctOf = (p) => (p == null ? null : Math.round(p * 1000) / 10);
function row(label, r, extra = {}) {
  if (!r || r.prob == null) return null;
  return { label, venue: r.venue, id: r.id, prob: r.prob, pct: pctOf(r.prob), bid: r.bid, ask: r.ask, volume: r.volume, thin: !!r.thin,
    link: r.link, embed: r.embed || null, endDate: r.endDate, status: r.status, closed: !!r.closed, ...extra };
}

const nameKey = (label) => String(label || '').toLowerCase().replace(/[^a-z]/g, '');

/**
 * Merge the Kalshi and Polymarket 2028-winner lists into one row per person, keyed by the letters of the
 * name ("J.D. Vance" and "JD Vance" collide). Yes = venueMean of the venues that price that person
 * (thin gating + cross-venue mean per §1.6); `byVenue` keeps each venue's own price/link for the Venue cell.
 */
export function mergeElection2028(kalshiRows, polymarketRows, top = 8) {
  const people = new Map();
  for (const [venue, list] of [['Kalshi', kalshiRows], ['Polymarket', polymarketRows]]) {
    for (const r of list || []) {
      if (!r || r.prob == null) continue;
      const key = nameKey(r.label);
      if (!key) continue;
      const e = people.get(key) || { label: r.label, rows: [] };
      if (venue === 'Kalshi') e.label = r.label;          // prefer Kalshi's yes_sub_title form
      if (!e.rows.some((x) => x.venue === r.venue)) e.rows.push(r);
      people.set(key, e);
    }
  }
  const out = [];
  for (const e of people.values()) {
    const vm = venueMean(e.rows);
    if (vm.value == null) continue;
    const byVenue = {};
    for (const r of e.rows) byVenue[r.venue] = { id: r.id, pct: pctOf(r.prob), prob: r.prob, link: r.link, volume: r.volume, thin: !!r.thin };
    const vols = e.rows.map((r) => r.volume).filter((v) => Number.isFinite(v));
    out.push({
      label: e.label, id: e.rows.map((r) => r.id).join('|'),
      venue: e.rows.length === 1 ? e.rows[0].venue : 'Kalshi + Polymarket', venues: vm.venues,
      prob: r4(vm.value), pct: pctOf(vm.value), thin: vm.thin,
      volume: vols.length ? vols.reduce((a, b) => a + b, 0) : null,
      link: e.rows[0].link, embed: null, endDate: e.rows[0].endDate || null, closed: e.rows.every((r) => r.closed), byVenue,
    });
  }
  out.sort((a, b) => b.prob - a.prob);
  return out.slice(0, top);
}

/** Build the display groups from the market maps. */
export function buildGroups({ kalshi = {}, polymarket = {}, monthly = null, election2028 = null }) {
  const k = (t) => kalshi[t], p = (s) => polymarket[s];
  const early = [
    row('Leaves office before Jan 20, 2029 (excl. death)', k(K.OUT_JAN2029), { primary: true }),
    row('Leaves office before 2028', k(K.OUT_28)),
    row('Leaves office before 2027', k(K.OUT_27)),
    row('Out as President before 2027', p(PM.OUT_2027)),
    monthly ? row(monthly.label || 'Out as President this month', monthly) : null,
    row('Resigns before term ends', k(K.RESIGN)),
    row('Resigns by Dec 31, 2026', p(PM.RESIGN_2026)),
    row('Impeached AND removed', k(K.REMOVE)),
    row('25th Amendment used before 2029', k(K.AMEND25), { note: 'a temporary transfer also counts' }),
    row('Removed via 25th Amendment before 2027', p(PM.AMEND25_2027)),
    row('Impeached (House vote) before Jan 20, 2029', k(K.IMPEACH_29), { note: 'impeachment ≠ removal' }),
    row('Impeached before term ends', p(PM.IMPEACH_TERM), { note: 'impeachment ≠ removal' }),
    row('Impeached before Jan 1, 2028', k(K.IMPEACH_28)),
    row('Impeached by Dec 31, 2026', p(PM.IMPEACH_2026)),
    row('Martial law before term ends', k(K.MARTIAL)),
    row('Insurrection Act invoked before Jan 20, 2029', k(K.INSURRECTION)),
  ].filter(Boolean);
  const occur = k(K.OCCUR2028);
  const stays = [
    row('Trump wins the 2028 election', k(K.WIN2028)),
    row('Trump wins the 2028 election', p(PM.WIN2028)),
    occur ? row('2028 election does not occur', { ...occur, prob: r4(1 - occur.prob) }, { note: '1 − "election occurs" market' }) : null,
    row('Trump is the 2028 GOP nominee', k(K.NOM2028)),
    row('Trump is the 2028 GOP nominee', p(PM.NOM2028)),
    row('Announces a 2028 run before Election Day', k(K.RUN2028), { note: 'Kalshi files this under "Trump run for a third term"' }),
    row('Repeals presidential term limits in 2026', p(PM.TERM_LIMITS)),
    row('A Trump family member is the 2028 GOP nominee', k(K.FAMILY2028)),
  ].filter(Boolean);
  const approval = [
    row('Approval below 37% at any point in 2026', k(K.APPROVAL_BELOW_37)),
    row('Approval hits 35% in 2026', p(PM.APPROVAL_35)),
  ].filter(Boolean);
  const e = election2028 || {};
  const election = [
    ...mergeElection2028(e.kalshi, e.polymarket, 8),
    row('Democrat wins in 2028', k(K.PARTY_D)),
    row('Republican wins in 2028', k(K.PARTY_R)),
  ].filter(Boolean);
  return { early, stays, approval, election2028: election };
}

/**
 * Assemble the full snapshot. Sources that failed pass their previous market map (carried forward)
 * with ok=false so the page never goes blank because one upstream hiccuped.
 */
export function buildSnapshot({
  now = Date.now(), config = {}, override = null, kvOverride = null,
  kalshi = { ok: false, markets: {} }, polymarket = { ok: false, markets: {} },
  monthly = null, election2028 = null, approval = null, newsMeta = null, prev = null,
} = {}) {
  const termEnd = config.termEnd || TERM_END_DEFAULT;
  const km = kalshi.markets || {}, pm = polymarket.markets || {};
  const ends = computeEnds({ kalshi: km, polymarket: pm });
  const early = computeEarly({ kalshi: km, polymarket: pm, monthly, now, termEnd });
  const v = computeVerdict({ now, termEnd, override: config.override ?? override, kvOverride, kalshi: km, polymarket: pm, monthly });
  // Keep the first "ended" timestamp once flipped so the date on the page doesn't drift.
  if (v.verdict === 'YES' && prev && prev.verdict === 'YES' && prev.endedAt && v.reason === prev.verdictReason) v.endedAt = prev.endedAt;
  const groups = buildGroups({ kalshi: km, polymarket: pm, monthly, election2028 });
  const daysLeft = Math.max(0, Math.floor((Date.parse(termEnd) - now) / 86400e3));
  // §1.6 "both down → serve the last-good snapshot with ITS updatedAt": only a successful market fetch
  // advances updatedAt; a carried-forward snapshot keeps chaining back to the last real fetch.
  const marketsFresh = !!kalshi.ok || !!polymarket.ok;
  const venueFlag = (v) => ({ ok: !!v.ok, at: v.at || null, error: v.error || null, partial: !!v.partial, missing: Array.isArray(v.missing) ? v.missing : [] });
  return {
    updatedAt: marketsFresh || !(prev && prev.updatedAt) ? new Date(now).toISOString() : prev.updatedAt,
    stale: !marketsFresh,
    termEnd,
    verdict: v.verdict, verdictReason: v.reason, endedAt: v.endedAt,
    daysLeft,
    ends, early,
    groups,
    approval: approval || (prev && prev.approval) || computeApproval({ now }),
    election2028: election2028 || null,
    monthly: monthly || null,
    markets: { kalshi: km, polymarket: pm },
    sources: {
      kalshi: venueFlag(kalshi),
      polymarket: venueFlag(polymarket),
      nyt: sourceFlag((approval || (prev && prev.approval) || {}).sources, 'nyt'),
      sb: sourceFlag((approval || (prev && prev.approval) || {}).sources, 'sb'),
      news: newsMeta || (prev && prev.sources && prev.sources.news) || { ok: false, at: null },
    },
    config: {
      termEnd, president: config.president || null, links: config.links || null, newsQuery: config.newsQuery || null,
      override: config.override ?? null, kvOverride: kvOverride ?? null,
    },
  };
}

function sourceFlag(sources, key) {
  const s = (sources || []).find((x) => x.key === key);
  return s ? { ok: !!s.ok, at: s.date || null, error: s.error || null } : { ok: false, at: null, error: null };
}
