// Server-side HTML rendering of the page sections + template fill. Pure functions, no I/O.
import { escapeHtml as h, safeHttpUrl } from './entities.js';

export const fmtPct = (pct, d = 1) => (pct == null || !Number.isFinite(pct) ? '—' : `${pct.toFixed(d)}%`);
export const fmtSigned = (n) => (n == null ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(1)}`);

export function fmtVolume(v) {
  if (v == null || !Number.isFinite(v)) return '';
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${Math.round(v / 1e3)}K`;
  return `$${Math.round(v)}`;
}

/** "3h ago", "2d ago", "just now". */
export function relTime(iso, now = Date.now()) {
  const t = Date.parse(iso); if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60); if (m < 60) return `${m}m ago`;
  const hr = Math.round(m / 60); if (hr < 48) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const nthSundayUtc = (y, month, n) => { const first = new Date(Date.UTC(y, month, 1)).getUTCDay(); return Date.UTC(y, month, 1 + ((7 - first) % 7) + (n - 1) * 7); };
/** US Eastern offset in hours (EDT −4 from the 2nd Sunday of March 2:00 to the 1st Sunday of November 2:00, else EST −5). */
export function easternOffsetHours(t) {
  const y = new Date(t).getUTCFullYear();
  const dstStart = nthSundayUtc(y, 2, 2) + 7 * 3600e3;   // 02:00 EST → 07:00 UTC
  const dstEnd = nthSundayUtc(y, 10, 1) + 6 * 3600e3;    // 02:00 EDT → 06:00 UTC
  return t >= dstStart && t < dstEnd ? -4 : -5;
}
/** "Sep 22, 2026" in America/New_York. Fixed formatter: the first toLocaleDateString(timeZone) call loads ICU tz data (~17 ms in Node). */
export function fmtDate(iso) {
  const t = Date.parse(iso); if (!Number.isFinite(t)) return '';
  const d = new Date(t + easternOffsetHours(t) * 3600e3);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/** Days-left line + title (also computed client-side; this is the no-JS seed). */
export function daysLine(snap, now = Date.now()) {
  const end = Date.parse(snap.termEnd);
  if (snap.verdict === 'YES') {
    return { text: snap.endedAt && Date.parse(snap.endedAt) <= now ? `It ended ${fmtDate(snap.endedAt)}` : '0 days left', title: `Term end: ${fmtDate(snap.termEnd)}, noon ET` };
  }
  const d = Math.max(0, Math.floor((end - now) / 86400e3));
  return { text: `${d.toLocaleString('en-US')} day${d === 1 ? '' : 's'} left`, title: `Term ends ${fmtDate(snap.termEnd)} at noon ET (${snap.termEnd})` };
}

function venueTag(venues) {
  if (!venues || venues.length !== 1) return '';
  return ` <span class="tag">(${h(venues[0])} only)</span>`;
}

/** Public copy for the YES banner; never prints the raw verdictReason (internal string). */
export function endedLabel(snap) {
  const r = String((snap && snap.verdictReason) || '');
  if (/term ended on schedule/.test(r)) return 'The term ended on schedule.';
  if (/^Kalshi .* settled YES$/.test(r)) return 'Kalshi\u2019s "leaves office" market settled YES.';
  if (/^Polymarket .* resolved YES$/.test(r)) return 'Polymarket\u2019s "out as President" market resolved YES.';
  return 'Marked as ended.';
}

export function renderHeadline(snap) {
  if (snap.verdict === 'YES') return `<p class="chance ended"><span class="k">${h(endedLabel(snap))}</span></p>`;
  const ends = snap.ends || {}, early = snap.early || {};
  const sub = early.expectEarly ? '<p class="expect">Markets now expect an early exit.</p>' : '';
  return `<p class="chance"><span class="k">Chance it actually ends:</span> <strong id="ends-pct">${fmtPct(ends.pct)}</strong>${venueTag(ends.venues)}</p>
<p class="chance secondary"><span class="k">Chance it ends early:</span> <strong id="early-pct">${fmtPct(early.pct)}</strong>${early.before2027 && early.before2027.pct != null ? ` <span class="tag">· before 2027: ${fmtPct(early.before2027.pct)}</span>` : ''}</p>${sub}`;
}

const thinFlag = '<span class="flag" title="wide spread or low liquidity">thin</span>';
function rowHtml(r) {
  // Merged rows (2028 candidates) list every venue with its own price; Yes is the cross-venue mean.
  const venue = r.byVenue
    ? Object.entries(r.byVenue).map(([v, x]) => `<a href="${h(x.link)}" target="_blank" rel="noopener">${h(v)}</a> <span class="vp">${fmtPct(x.pct)}</span>${x.thin ? ' ' + thinFlag : ''}`).join(' · ')
    : `<a href="${h(r.link)}" target="_blank" rel="noopener">${h(r.venue)}</a>`;
  const flags = [r.thin && !r.byVenue ? thinFlag : '', r.closed ? '<span class="flag">closed</span>' : ''].filter(Boolean).join(' ');
  const note = r.note ? `<span class="note">${h(r.note)}</span>` : '';
  return `<tr${r.primary ? ' class="primary"' : ''}><th scope="row">${h(r.label)}${note}</th><td class="num">${fmtPct(r.pct)}</td><td>${venue}${flags ? ' ' + flags : ''}</td><td class="vol">${h(fmtVolume(r.volume))}</td></tr>`;
}

function tableHtml(caption, rows, id) {
  if (!rows || !rows.length) return `<h3 id="${id}">${h(caption)}</h3><p class="unavail">Unavailable.</p>`;
  return `<h3 id="${id}">${h(caption)}</h3>
<div class="tablewrap"><table aria-labelledby="${id}"><thead><tr><th scope="col">Market</th><th scope="col" class="num">Yes</th><th scope="col">Venue</th><th scope="col">Volume</th></tr></thead>
<tbody>${rows.map(rowHtml).join('\n')}</tbody></table></div>`;
}

/** Polymarket embed placeholders (lazy-loaded by app.js; plain link fallback always present). */
export function renderEmbeds(snap) {
  const pm = (snap.markets && snap.markets.polymarket) || {};
  const want = [
    { slug: 'trump-out-as-president-before-2027', label: 'Out as President before 2027' },
    { slug: 'will-trump-be-impeached-before-his-term-ends', label: 'Impeached before term ends' },
  ].filter((w) => pm[w.slug] && !pm[w.slug].closed);
  const blocks = want.map((w) => {
    const m = pm[w.slug];
    return `<figure class="embed" data-embed="${h(m.embed)}" data-label="${h(w.label)}"><figcaption><a href="${h(m.link)}" target="_blank" rel="noopener">${h(w.label)} on Polymarket</a> — ${fmtPct(m.prob == null ? null : m.prob * 100)}</figcaption></figure>`;
  });
  if (snap.election2028 && snap.election2028.polymarket && snap.election2028.polymarket.length) {
    blocks.push(`<figure class="embed" data-embed="https://embed.polymarket.com/market?event=presidential-election-winner-2028&amp;rotate=true&amp;theme=light&amp;buttons=false" data-label="2028 election winner"><figcaption><a href="https://polymarket.com/event/presidential-election-winner-2028" target="_blank" rel="noopener">2028 election winner on Polymarket</a></figcaption></figure>`);
  }
  return blocks.length ? `<div class="embeds">${blocks.join('\n')}</div>` : '';
}

const VENUE_NAME = { kalshi: 'Kalshi', polymarket: 'Polymarket' };
export function renderOdds(snap, now = Date.now()) {
  const g = snap.groups || {};
  const src = snap.sources || {};
  const down = ['kalshi', 'polymarket'].filter((k) => src[k] && !src[k].ok);
  const at = down.length ? src[down[0]].at : null;
  let warn = down.length ? `<p class="warn">${down.map((k) => VENUE_NAME[k]).join(' and ')} unavailable — showing last good values${at ? ` from <time datetime="${h(at)}">${h(relTime(at, now))}</time>` : ''}.</p>` : '';
  // A 200 that omits some of the expected markets: rows are simply missing, say so.
  for (const k of ['kalshi', 'polymarket']) {
    const v = src[k];
    if (v && v.ok && v.partial && Array.isArray(v.missing) && v.missing.length) {
      warn += `<p class="warn">${VENUE_NAME[k]} did not return ${v.missing.length} of the expected markets (${h(v.missing.join(', '))}) — those rows are omitted.</p>`;
    }
  }
  const anyRows = ['early', 'stays', 'election2028'].some((k) => g[k] && g[k].length);
  if (!anyRows) return `<p class="unavail">Odds unavailable right now.</p>`;
  return `${warn}${tableHtml('Leaves early', g.early, 'odds-early')}
${tableHtml('Third term / stays', g.stays, 'odds-stays')}
${tableHtml('2028 election', g.election2028, 'odds-2028')}
${g.approval && g.approval.length ? tableHtml('Approval (market view)', g.approval, 'odds-approval') : ''}
${renderEmbeds(snap)}
<p class="fine">No market on either venue prices the president's death or health; Kalshi's "leaves office" market explicitly excludes it. The 25th-Amendment rows are the closest proxy. Polymarket markets are display-only for US users.</p>`;
}

export function renderApproval(snap) {
  const a = snap.approval;
  if (!a || a.approve == null) return `<p class="unavail">Approval unavailable.</p>`;
  const srcs = (a.sources || []).map((s) => s.ok
    ? `<li><a href="${h(s.link)}" target="_blank" rel="noopener">${h(s.name)}</a>: ${s.approve.toFixed(1)} / ${s.disapprove.toFixed(1)} <span class="tag">(${h(s.date)})</span></li>`
    : `<li><a href="${h(s.link)}" target="_blank" rel="noopener">${h(s.name)}</a>: <span class="tag">unavailable</span></li>`).join('');
  return `<dl class="approval"><div><dt>Approve</dt><dd>${a.approve.toFixed(1)}%</dd></div><div><dt>Disapprove</dt><dd>${a.disapprove.toFixed(1)}%</dd></div><div><dt>Net</dt><dd>${fmtSigned(a.net)}</dd></div></dl>
<ul class="sources">${srcs}</ul>${a.partial ? '<p class="tag">One source only — the other is stale or down.</p>' : ''}`;
}

export function renderNews(news, now = Date.now()) {
  // KV `news` is rendered verbatim, so guard the href scheme here too (items written before the rss.js filter persist until the next news job).
  const items = ((news && news.items) || []).filter((it) => it && safeHttpUrl(it.link));
  if (!items.length) return `<p class="unavail">News unavailable.</p>`;
  return `<ol class="news">${items.slice(0, 30).map((it) => `<li><a href="${h(it.link)}" target="_blank" rel="noopener">${h(it.title)}</a> <span class="src">${h(it.source || '')}${it.pubDate ? ` · <time datetime="${h(it.pubDate)}">${relTime(it.pubDate, now)}</time>` : ''}</span></li>`).join('\n')}</ol>`;
}

/** Fill `{{key}}` placeholders. Values are already HTML (callers escape). Unknown keys → ''. */
export function fillTemplate(tpl, vars) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? String(vars[k]) : ''));
}

const faviconSvg = (answer) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#fff"/><text x="32" y="46" font-family="Georgia,serif" font-weight="700" font-size="${answer.length > 2 ? 30 : 40}" text-anchor="middle" fill="#000">${answer}</text></svg>`)}`;

/** Build every template variable for index.html from a snapshot + news. */
export function pageVars({ snap, news, origin = '', now = Date.now() }) {
  const answer = snap.verdict === 'YES' ? 'YES' : 'NO';
  const dl = daysLine(snap, now);
  const c = snap.config || {};
  const p = c.president || {};
  const ends = snap.ends && snap.ends.pct != null ? `${snap.ends.pct.toFixed(1)}%` : 'unknown';
  const desc = answer === 'YES'
    ? `${answer}. ${dl.text}. Live odds, approval and news on the ${p.name || 'presidential'} term.`
    : `${answer}. ${dl.text}. Chance it actually ends by Jan 20, 2029: ${ends}. Live odds, approval and news on the ${p.name || 'presidential'} term.`;
  const stateJson = JSON.stringify({
    updatedAt: snap.updatedAt, stale: !!snap.stale, termEnd: snap.termEnd, verdict: answer, verdictReason: snap.verdictReason || null, endedAt: snap.endedAt, ends: snap.ends, early: snap.early,
    approval: snap.approval && { approve: snap.approval.approve, disapprove: snap.approval.disapprove, net: snap.approval.net }, sources: snap.sources,
  }).replace(/</g, '\\u003c');
  const newsAt = news && news.updatedAt;
  return {
    answer, answerClass: answer.toLowerCase(), daysLine: h(dl.text), daysTitle: h(dl.title),
    headline: renderHeadline(snap), odds: renderOdds(snap, now), approval: renderApproval(snap), news: renderNews(news, now),
    updatedIso: h(snap.updatedAt || ''), updatedRel: h(relTime(snap.updatedAt, now)),
    newsUpdatedIso: h(newsAt || ''), newsUpdatedRel: h(newsAt ? relTime(newsAt, now) : ''),
    stateJson, ogDescription: h(desc), origin: h(origin), favicon: faviconSvg(answer),
    presidentName: h(p.name || 'The President'), portrait: h(p.portrait || '/portrait.jpg'), portraitFull: h(p.portraitFull || '/portrait-full.jpg'),
    credit: h(p.portraitCredit || ''), coffee: h((c.links || {}).coffee || '#'), github: h((c.links || {}).github || '#'),
    termEndHuman: h(fmtDate(snap.termEnd)),
    verdictReason: h(snap.verdictReason || ''),
  };
}
