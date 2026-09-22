// Venue parsers: Kalshi (dollar strings) and Polymarket Gamma (JSON-string outcomePrices).
// Every market becomes a normalized row:
//   { id, venue, title, prob, bid, ask, last, volume, liquidity, endDate, thin, link, embed, status, result, closed, spread }

const num = (v) => { const n = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(n) ? n : null; };
const round4 = (n) => (n == null ? null : Math.round(n * 1e4) / 1e4);

export const KALSHI_THIN_SPREAD = 0.05;          // ask − bid > 0.05 → thin
export const PM_MIN_LIQUIDITY = 5000;             // trust only when liquidity > 5000 …
export const PM_THIN_SPREAD = 0.05;               // … and ask − bid < 0.05

/** Kalshi market link: /markets/<series_lower>/x/<event_lower> (series = event ticker minus trailing -suffix chain). */
export function kalshiLink(m) {
  const ev = String(m.event_ticker || m.ticker || '').toLowerCase();
  const series = ev.split('-')[0];
  return `https://kalshi.com/markets/${series}/x/${ev}`;
}

/** Normalize one Kalshi market object. */
export function kalshiRow(m) {
  const bid = num(m.yes_bid_dollars), ask = num(m.yes_ask_dollars), last = num(m.last_price_dollars);
  // Settlement is keyed on `result` ("" while open, "yes"/"no" once determined/finalized): a settled market's
  // book is 0/1 and `last` is the pre-close trade, never the settlement, so the price is the payout itself.
  const res = String(m.result || '').toLowerCase();
  const settled = res === 'yes' || res === 'no';
  let prob = settled ? (res === 'yes' ? 1 : 0) : (bid != null && ask != null ? (bid + ask) / 2 : last);
  if (!settled && prob != null && bid === 0 && ask === 1) prob = last ?? prob;   // empty book
  const spread = bid != null && ask != null ? ask - bid : null;
  return {
    id: m.ticker, venue: 'Kalshi', title: m.title || '', sub: m.yes_sub_title || '',
    prob: round4(prob), bid, ask, last, spread: round4(spread),
    volume: num(m.volume_fp), liquidity: num(m.liquidity_dollars),
    endDate: m.close_time || null,
    thin: !settled && (spread == null || spread > KALSHI_THIN_SPREAD),
    link: kalshiLink(m), embed: null,
    status: m.status || null, result: m.result || '', closed: settled || m.status === 'finalized' || m.status === 'settled',
    updatedAt: m.updated_time || null,   // bumped on settlement: the best available "ended at" for a finalized YES
  };
}

/** Parse the /markets?tickers=... batch → { [ticker]: row }. */
export function parseKalshiBatch(json) {
  const markets = json && Array.isArray(json.markets) ? json.markets : (json && json.market ? [json.market] : null);
  if (!markets) throw new Error('Kalshi: no markets[]');
  const out = {};
  for (const m of markets) if (m && m.ticker) out[m.ticker] = kalshiRow(m);
  // A batch of known tickers can never legitimately be empty (settled markets still come back as finalized);
  // an empty 200 (ticker re-series, partial outage) must NOT count as success or it wipes the last-good map.
  if (!Object.keys(out).length) throw new Error('Kalshi: 0 markets returned');
  return out;
}

/** Parse outcomePrices (JSON-encoded string, or already an array). Index 0 = Yes. */
export function pmYes(m) {
  let arr = m && m.outcomePrices;
  if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch { arr = null; } }
  if (Array.isArray(arr) && arr.length) {
    const p = num(arr[0]);
    if (p != null) return p;
  }
  return num(m && m.lastTradePrice);
}

/** Normalize one Polymarket Gamma market object. `eventSlug` is used for the outbound link. */
export function polymarketRow(m, eventSlug) {
  const bid = num(m.bestBid), ask = num(m.bestAsk), last = num(m.lastTradePrice);
  const prob = pmYes(m);
  const liquidity = num(m.liquidity), spread = bid != null && ask != null ? ask - bid : num(m.spread);
  const thin = !(liquidity != null && liquidity > PM_MIN_LIQUIDITY && spread != null && spread < PM_THIN_SPREAD);
  let arr = m.outcomePrices; if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch { arr = null; } }
  const ev = eventSlug || (m.events && m.events[0] && m.events[0].slug) || m.slug;
  return {
    id: m.slug, pmId: m.id != null ? String(m.id) : null, venue: 'Polymarket',
    title: m.question || m.groupItemTitle || '', sub: m.groupItemTitle || '',
    prob: round4(prob), bid, ask, last, spread: round4(spread),
    volume: num(m.volume), liquidity, endDate: m.endDate || null, thin,
    link: `https://polymarket.com/event/${ev}`,
    embed: `https://embed.polymarket.com/market?market=${encodeURIComponent(m.slug)}&theme=light&buttons=false`,
    status: m.closed ? 'closed' : (m.active ? 'active' : 'inactive'), result: '',
    closed: !!m.closed, resolvedYes: !!m.closed && Array.isArray(arr) && String(arr[0]) === '1',
  };
}

/** Parse /events/keyset → { [marketSlug]: row } over every market of every event. */
export function parsePolymarketKeyset(json) {
  const events = json && Array.isArray(json.events) ? json.events : (Array.isArray(json) ? json : null);
  if (!events) throw new Error('Polymarket: no events[]');
  const out = {};
  for (const e of events) for (const m of e.markets || []) if (m && m.slug) out[m.slug] = polymarketRow(m, e.slug);
  if (!Object.keys(out).length) throw new Error('Polymarket: 0 markets returned');   // {events:[]} is a 200 for unknown slugs
  return out;
}

/** Parse /markets/slug/<slug> (single object) → row. */
export function parsePolymarketMarket(json) {
  if (!json || !json.slug) throw new Error('Polymarket: no market');
  return polymarketRow(json);
}

/**
 * Parse the 2028 winner event → sorted [{label, prob, ...}] (top N), skipping placeholders
 * (76/128 markets have no outcomePrices). Names from groupItemTitle/question, never the slug.
 */
export function parsePolymarket2028(json, top = 8) {
  const e = Array.isArray(json) ? json[0] : json;
  if (!e || !Array.isArray(e.markets)) throw new Error('Polymarket 2028: no markets');
  const rows = e.markets
    .filter((m) => m.active && m.outcomePrices)
    .map((m) => ({ ...polymarketRow(m, e.slug), label: m.groupItemTitle || m.question }))
    .filter((r) => r.prob != null)
    .sort((a, b) => b.prob - a.prob);
  if (!rows.length) throw new Error('Polymarket 2028: 0 priced markets');
  return rows.slice(0, top);
}

/** Kalshi KXPRESPERSON-28 market list → sorted [{label, prob, ...}] top N. */
export function parseKalshi2028(json, top = 8) {
  const markets = json && Array.isArray(json.markets) ? json.markets : null;
  if (!markets) throw new Error('Kalshi 2028: no markets');
  const rows = markets.map((m) => ({ ...kalshiRow(m), label: m.yes_sub_title || m.title }))
    .filter((r) => r.prob != null)
    .sort((a, b) => b.prob - a.prob);
  if (!rows.length) throw new Error('Kalshi 2028: 0 markets returned');
  return rows.slice(0, top);
}

/**
 * §1.1.1 Pick the rolling "out by <month-end>" Polymarket event from a title_search keyset.
 * Returns the event slug with the earliest future endDate matching /^d?trump-out-as-president/, or null.
 */
export function pickMonthlyOutEvent(json, now = Date.now()) {
  const events = json && Array.isArray(json.events) ? json.events : [];
  const cands = events
    .filter((e) => /^d?trump-out-as-president/.test(e.slug || '') && e.slug !== 'trump-out-as-president-before-2027')
    .filter((e) => e.endDate && Date.parse(e.endDate) > now)
    .sort((a, b) => Date.parse(a.endDate) - Date.parse(b.endDate));
  return cands.length ? cands[0].slug : null;
}
