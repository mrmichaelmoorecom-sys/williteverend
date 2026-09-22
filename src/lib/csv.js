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
 */
export function parseNyt(text) {
  const rows = parseCsv(text).filter((r) => r.topic === '2025 Approval - Trump' && /^\d{4}-\d{2}-\d{2}$/.test(r.date));
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
 */
export function parseSilverBulletin(text) {
  const rows = parseCsv(text).filter((r) => r.modeldate && r.approve);
  if (!rows.length) throw new Error('SB: empty');
  const last = rows[rows.length - 1];
  const approve = parseFloat(last.approve), disapprove = parseFloat(last.disapprove);
  if (!Number.isFinite(approve) || !Number.isFinite(disapprove)) throw new Error('SB: bad numbers');
  const m = last.modeldate.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const date = m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : last.modeldate;
  return { approve, disapprove, date };
}
