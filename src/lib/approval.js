// The approval source registry, plus the parsers for the sources that are not plain CSV (NYT and Silver
// Bulletin live in csv.js). Every parser takes a raw body and returns {approve, disapprove, date} — or
// {net, date} for a net-only series. Nothing here fetches; see fetchApproval in index.js.
//
// CPU: these bodies are big (RCP ~5.7 MB, DDHQ ~1.5 MB) and the Worker runs on the Free plan's 10 ms CPU
// budget per invocation, so each parser uses indexOf to cut a small window out of the document and only
// then runs a regex over that window. Never run a lazy `.*?` across a whole body in here — on 5.7 MB it
// is the difference between a parse and error 1102 (CPU exceeded), which writes nothing at all.

/** Window kept after an anchor before any regex runs. The blocks of interest sit within a few KB of it. */
const WINDOW = 64 * 1024;
const unescapeJson = (s) => s.replace(/\\"/g, '"');
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : NaN; };

/**
 * A bare M/D with no year (RCP prints poll windows like "9/2 - 9/20") resolved against the clock: this
 * year, unless that lands more than two days ahead, which means the window belongs to last year.
 */
export function inferYear(month, day, now = Date.now()) {
  const mm = String(month).padStart(2, '0'), dd = String(day).padStart(2, '0');
  const y = new Date(now).getUTCFullYear();
  const iso = `${y}-${mm}-${dd}`;
  return Date.parse(`${iso}T00:00:00Z`) > now + 2 * 86400e3 ? `${y - 1}-${mm}-${dd}` : iso;
}

/**
 * RealClearPolling approval page → {approve, disapprove, date}.
 * The averages ride in JSON that is escaped inside the HTML (`\"id\":\"8656\",\"type\":\"rcp_average\"`),
 * so anchor on that, unescape only the window, and cut again at "spread" — the marker that ends the block.
 * `date` is a poll window ("9/2 - 9/20"); the END of the range is what the average is current as of.
 */
export function parseRcp(html, { now = Date.now(), pollId = '8656' } = {}) {
  const s = String(html ?? '');
  const i = s.indexOf(`\\"id\\":\\"${pollId}\\",\\"type\\":\\"rcp_average\\"`);
  if (i < 0) throw new Error('RCP: no rcp_average block');
  const win = unescapeJson(s.slice(i, i + WINDOW));
  const cut = win.indexOf('"spread":');
  const block = win.slice(0, cut > 0 ? cut + 200 : 4000);
  const pick = (name) => {
    const m = block.match(new RegExp(`"name":"${name}"[^}]*?"value":"?([\\d.]+)"?`))
      || block.match(new RegExp(`"value":"?([\\d.]+)"?[^}]*?"name":"${name}"`));
    return m ? num(m[1]) : NaN;
  };
  const approve = pick('Approve'), disapprove = pick('Disapprove');
  if (!Number.isFinite(approve) || !Number.isFinite(disapprove)) throw new Error('RCP: no Approve/Disapprove values');
  const dm = block.match(/"date":"([^"]*)"/);
  const range = dm ? dm[1] : '';
  // Take the last M/D in the string: "9/2 - 9/20" is a window, and its end is the freshness date.
  const parts = [...range.matchAll(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/g)];
  const last = parts[parts.length - 1];
  if (!last) throw new Error('RCP: no date');
  const date = last[3]
    ? `${last[3].length === 2 ? `20${last[3]}` : last[3]}-${last[1].padStart(2, '0')}-${last[2].padStart(2, '0')}`
    : inferYear(last[1], last[2], now);
  return { approve, disapprove, date };
}

/**
 * Decision Desk HQ approval page → {approve, disapprove, date} for the newest point of the timeseries.
 * Shape (escaped in the HTML): "timeseries":[{"date":"2026-09-20Z","data":[{"option_id":3,"value":39},…]}]
 * with option_id 3 = Approve and 4 = Disapprove. The entries are read in full and the max date wins, so
 * the parser does not care whether the series is ascending or descending.
 */
export function parseDdhq(html, { approveId = 3, disapproveId = 4 } = {}) {
  const s = String(html ?? '');
  // The page carries its JSON escaped inside the HTML (\"timeseries\":); a plain embed is handled too.
  let esc = true, i = s.indexOf('\\"timeseries\\":');
  if (i < 0) { esc = false; i = s.indexOf('"timeseries":'); }
  if (i < 0) throw new Error('DDHQ: no timeseries');
  // A daily series over a term runs to a few hundred entries; this covers it with room to spare.
  const win = s.slice(i, i + 16 * WINDOW);
  // Three deliberate economies, all of them measured on a 1.5 MB body against the 10 ms CPU budget:
  // scan in the document's own escaped form so the window is never unescaped wholesale (2.2 → 1.4 ms),
  // match only dates rather than lazily capturing each entry's data array, and unescape just the one
  // newest entry (1.4 → 0.2 ms). Only that entry is then read for values.
  const q = esc ? '\\\\"' : '"';
  let date = '', at = -1;
  for (const m of win.matchAll(new RegExp(`${q}date${q}:${q}(\\d{4}-\\d{2}-\\d{2})`, 'g'))) {
    if (m[1] > date) { date = m[1]; at = m.index; }
  }
  if (at < 0) throw new Error('DDHQ: no dated points');
  const openTok = esc ? '\\"data\\":[' : '"data":[';
  const open = win.indexOf(openTok, at);
  const close = open > 0 ? win.indexOf(']', open) : -1;
  if (close < 0) throw new Error('DDHQ: no data array for the newest point');
  const entry = unescapeJson(win.slice(open + openTok.length, close));
  let approve = NaN, disapprove = NaN;
  for (const obj of entry.split(/\},\s*\{/)) {
    const id = obj.match(/"option_id":\s*(\d+)/), val = obj.match(/"value":\s*(-?[\d.]+)/);
    if (!id || !val) continue;
    if (+id[1] === approveId) approve = num(val[1]);
    else if (+id[1] === disapproveId) disapprove = num(val[1]);
  }
  if (!Number.isFinite(approve) || !Number.isFinite(disapprove)) throw new Error('DDHQ: newest point has no Approve/Disapprove');
  return { approve, disapprove, date };
}

/**
 * YouGov/Economist weekly tracker → {approve, disapprove, date}.
 * `overall` carries LOWESS-smoothed `values` (what the published tracker shows) with `raw_values` as the
 * unsmoothed fallback; series 0 is Approve, 1 is Disapprove. The dates live in a separate `details`
 * payload as ms-epoch `timestamps`, so the caller fetches both and hands them over together.
 */
export function parseYouGov(overall, details) {
  const o = overall || {};
  const series = (Array.isArray(o.values) && o.values.length ? o.values : o.raw_values) || [];
  const lastOf = (a) => (Array.isArray(a) && a.length ? num(a[a.length - 1]) : NaN);
  const approve = lastOf(series[0]), disapprove = lastOf(series[1]);
  if (!Number.isFinite(approve) || !Number.isFinite(disapprove)) throw new Error('YouGov: no values');
  const ts = (details && details.timestamps) || [];
  const t = Array.isArray(ts) && ts.length ? Number(ts[ts.length - 1]) : NaN;
  if (!Number.isFinite(t)) throw new Error('YouGov: no timestamps');
  return { approve, disapprove, date: new Date(t).toISOString().slice(0, 10) };
}

/**
 * Strength In Numbers (Datawrapper z8nax) dataset.csv → {net, date} from the last row.
 * Header: `Date,Overall,…` with ISO dates; `Overall` is NET approval, not an approve share — there is no
 * approve/disapprove split in this series, which is why it is displayed but never averaged.
 */
export function parseStrengthInNumbers(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const header = (lines[0] || '').split(',').map((h) => h.trim());
  const iDate = header.indexOf('Date'), iNet = header.indexOf('Overall');
  if (iDate < 0 || iNet < 0) throw new Error('SIN: unexpected header');
  for (let i = lines.length - 1; i >= 1; i--) {
    const f = lines[i].split(',');
    const date = (f[iDate] || '').trim(), net = num((f[iNet] || '').trim());
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(net)) return { net: Math.round(net * 10) / 10, date };
  }
  throw new Error('SIN: no usable row');
}

/**
 * Every approval source, in display order.
 *
 * `kind` decides what a source is allowed to do:
 *   average — a poll aggregator with an approve/disapprove split. These, and only these, are averaged
 *             into the headline number, so it stays an average of comparable aggregates.
 *   poll    — a single pollster. Shown for context; giving one house the same weight as an aggregate
 *             of every house would distort the headline.
 *   net     — a net-only series, with no approve/disapprove split to average.
 *
 * `maxAgeDays` is per source because the publication cadences differ: the dailies get the original
 * 7.5-day rule, RCP's dated poll window trails publication, and YouGov is a weekly tracker whose last
 * point is routinely over a week old (it was 8 days old when the spec was verified).
 *
 * `link` is only set where docs/DATA_SOURCES.md records a human-facing page that was actually checked;
 * the rest render as plain text rather than ship a guessed URL.
 */
export const APPROVAL_SOURCES = [
  { key: 'nyt', name: 'NYT polling average', kind: 'average', maxAgeDays: 7.5,
    link: 'https://www.nytimes.com/interactive/polls/donald-trump-approval-rating-polls.html' },
  { key: 'sb', name: 'Silver Bulletin', kind: 'average', maxAgeDays: 7.5,
    link: 'https://www.natesilver.net/p/trump-approval-ratings-nate-silver-bulletin' },
  { key: 'rcp', name: 'RealClearPolling', kind: 'average', maxAgeDays: 10,
    link: 'https://www.realclearpolling.com/polls/approval/donald-trump/approval-rating' },
  { key: 'ddhq', name: 'Decision Desk HQ', kind: 'average', maxAgeDays: 7.5,
    link: 'https://votes.decisiondeskhq.com/polls/presidential-approval/donald-j-trump-5/national/lv-rv-adults' },
  { key: 'yougov', name: 'YouGov/Economist', kind: 'poll', maxAgeDays: 14, link: null, note: 'single pollster, not averaged' },
  { key: 'sin', name: 'Strength In Numbers', kind: 'net', maxAgeDays: 7.5, link: null, note: 'net only, not averaged · CC BY-NC 4.0' },
];

export const APPROVAL_KEYS = APPROVAL_SOURCES.map((s) => s.key);
/** Keys whose numbers move the headline, i.e. the aggregators. */
export const AVERAGED_KEYS = APPROVAL_SOURCES.filter((s) => s.kind === 'average').map((s) => s.key);
