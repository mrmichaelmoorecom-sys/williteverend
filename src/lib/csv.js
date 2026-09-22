// Tiny CSV parser + the two approval-average parsers (NYT, Silver Bulletin/Datawrapper).

/** Parse CSV into array of objects keyed by the header row. Handles quoted fields. */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

/**
 * NYT president-averages.csv → {approve, disapprove, date} for the latest Trump row.
 * Header: topic,date,answer,pct ; filter topic === "2025 Approval - Trump".
 * Fast path: the file has no quoted fields, so split lines/commas and only look at Trump rows
 * (~0.9 ms cold vs ~7 ms through the char-by-char parser). parseCsv is the fallback when a quote is present.
 */
const NYT_TOPIC = '2025 Approval - Trump';
export function parseNyt(text) {
  const s = String(text ?? '');
  let rows;
  if (s.includes('"')) {
    rows = parseCsv(s).filter((r) => r.topic === NYT_TOPIC);
  } else {
    const lines = s.split(/\r?\n/);
    const header = (lines[0] || '').split(',').map((h) => h.trim());
    const ix = { topic: header.indexOf('topic'), date: header.indexOf('date'), answer: header.indexOf('answer'), pct: header.indexOf('pct') };
    if (Object.values(ix).some((i) => i < 0)) throw new Error('NYT: unexpected header');
    rows = [];
    for (let i = 1; i < lines.length; i++) {
      const l = lines[i];
      if (!l.includes(NYT_TOPIC)) continue;
      const f = l.split(',');
      if ((f[ix.topic] || '').trim() !== NYT_TOPIC) continue;
      rows.push({ topic: NYT_TOPIC, date: (f[ix.date] || '').trim(), answer: (f[ix.answer] || '').trim(), pct: (f[ix.pct] || '').trim() });
    }
  }
  rows = rows.filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date));
  if (!rows.length) throw new Error('NYT: no Trump rows');
  const date = rows.reduce((m, r) => (r.date > m ? r.date : m), '');
  const latest = rows.filter((r) => r.date === date);
  const pick = (a) => { const r = latest.find((x) => x.answer === a); return r ? parseFloat(r.pct) : NaN; };
  const approve = pick('Approve'), disapprove = pick('Disapprove');
  if (!Number.isFinite(approve) || !Number.isFinite(disapprove)) throw new Error('NYT: bad pct');
  return { approve, disapprove, date };
}

/** Datawrapper resolver HTML → version string (e.g. "7832"). Capture the group; the id has a digit. */
export function parseDatawrapperVersion(html, chartId = 'kSCt4') {
  const m = String(html ?? '').match(new RegExp(`${chartId}\\/(\\d+)\\/`));
  if (!m) throw new Error('Datawrapper: no version in resolver');
  return m[1];
}

/**
 * Silver Bulletin dataset.csv → {approve, disapprove, date} from the LAST row.
 * Header: modeldate,approve,disapprove,... ; dates M/D/YYYY ascending.
 * Fast path (no quotes in the file): header + last non-empty line only.
 */
export function parseSilverBulletin(text) {
  const s = String(text ?? '');
  let last = null;
  if (s.includes('"')) {
    const rows = parseCsv(s).filter((r) => r.modeldate && r.approve);
    last = rows.length ? rows[rows.length - 1] : null;
  } else {
    const lines = s.split(/\r?\n/);
    const header = (lines[0] || '').split(',').map((h) => h.trim());
    const iDate = header.indexOf('modeldate'), iA = header.indexOf('approve'), iD = header.indexOf('disapprove');
    if (iDate < 0 || iA < 0 || iD < 0) throw new Error('SB: unexpected header');
    for (let i = lines.length - 1; i >= 1; i--) {
      const f = lines[i].split(',');
      if (f.length < header.length || !f[iDate].trim() || !f[iA].trim()) continue;
      last = { modeldate: f[iDate].trim(), approve: f[iA].trim(), disapprove: f[iD].trim() };
      break;
    }
  }
  if (!last) throw new Error('SB: empty');
  const approve = parseFloat(last.approve), disapprove = parseFloat(last.disapprove);
  if (!Number.isFinite(approve) || !Number.isFinite(disapprove)) throw new Error('SB: bad numbers');
  const m = last.modeldate.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const date = m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : last.modeldate;
  return { approve, disapprove, date };
}
