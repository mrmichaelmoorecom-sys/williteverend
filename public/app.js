// Client hydration: live countdown, relative times, lazy Polymarket embeds, periodic refresh of the headline.
(function () {
  'use strict';
  var stateEl = document.getElementById('state');
  var state = {};
  try { state = JSON.parse(stateEl ? stateEl.textContent : '{}') || {}; } catch (e) { state = {}; }
  var termEnd = Date.parse(state.termEnd || '2029-01-20T17:00:00Z');

  function fmtDate(iso) {
    var t = Date.parse(iso); if (!isFinite(t)) return '';
    return new Date(t).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'America/New_York' });
  }
  function relTime(iso) {
    var t = Date.parse(iso); if (!isFinite(t)) return '';
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return 'just now';
    var m = Math.round(s / 60); if (m < 60) return m + 'm ago';
    var h = Math.round(m / 60); if (h < 48) return h + 'h ago';
    return Math.round(h / 24) + 'd ago';
  }
  function pct(x) { return x == null || !isFinite(x) ? '—' : x.toFixed(1) + '%'; }

  function renderCountdown() {
    var el = document.getElementById('days'); if (!el) return;
    var now = Date.now();
    if (state.verdict === 'YES') {
      var ended = state.endedAt && Date.parse(state.endedAt) <= now;
      el.textContent = ended ? 'It ended ' + fmtDate(state.endedAt) : '0 days left';
      return;
    }
    var ms = termEnd - now;
    var d = Math.max(0, Math.floor(ms / 864e5));
    el.textContent = d.toLocaleString('en-US') + ' day' + (d === 1 ? '' : 's') + ' left';
    var hrs = Math.max(0, Math.floor(ms / 36e5)), mins = Math.max(0, Math.floor(ms / 6e4) % 60);
    el.title = 'Term ends ' + fmtDate(state.termEnd) + ' at noon ET — ' + hrs.toLocaleString('en-US') + ' hours, ' + mins + ' minutes';
  }

  function renderTimes() {
    var times = document.querySelectorAll('time[datetime]');
    for (var i = 0; i < times.length; i++) {
      var iso = times[i].getAttribute('datetime');
      if (iso) times[i].textContent = relTime(iso);
    }
  }

  // Same public copy as render.js endedLabel(); never prints the raw reason.
  function endedLabel(reason) {
    reason = String(reason || '');
    if (/term ended on schedule/.test(reason)) return 'The term ended on schedule.';
    if (/^Kalshi .* settled YES$/.test(reason)) return 'Kalshi\u2019s "leaves office" market settled YES.';
    if (/^Polymarket .* resolved YES$/.test(reason)) return 'Polymarket\u2019s "out as President" market resolved YES.';
    return 'Marked as ended.';
  }
  // Once the answer is YES the "chance it ends" lines are moot: remove them and show why it ended (idempotent).
  function renderEndedBanner(s) {
    var banner = document.getElementById('banner'); if (!banner) return;
    var old = banner.querySelectorAll('.chance:not(.ended), .expect');
    for (var i = 0; i < old.length; i++) old[i].parentNode.removeChild(old[i]);
    if (!banner.querySelector('.chance.ended')) {
      var p = document.createElement('p'); p.className = 'chance ended';
      var k = document.createElement('span'); k.className = 'k'; k.textContent = endedLabel(s.verdictReason);
      p.appendChild(k);
      var details = banner.querySelector('details');
      if (details) banner.insertBefore(p, details); else banner.appendChild(p);
    }
  }

  function applyState(s) {
    if (!s || !s.verdict) return;
    state = s;
    termEnd = Date.parse(s.termEnd || state.termEnd) || termEnd;
    var a = document.getElementById('answer');
    if (a && a.textContent.trim() !== s.verdict) {
      a.textContent = s.verdict;
      document.body.className = 'answer-' + s.verdict.toLowerCase();
      document.title = 'Will it ever end? ' + s.verdict;
    }
    if (s.verdict === 'YES') {
      renderEndedBanner(s);
    } else {
      var e = document.getElementById('ends-pct'); if (e && s.ends) e.textContent = pct(s.ends.pct);
      var y = document.getElementById('early-pct'); if (y && s.early) y.textContent = pct(s.early.pct);
    }
    var u = document.getElementById('updated'); if (u && s.updatedAt) { u.setAttribute('datetime', s.updatedAt); }
    renderCountdown(); renderTimes();
  }

  function refresh() {
    if (!window.fetch) return;
    fetch('/api/state', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (s) {
      if (!s) return;
      applyState({ verdict: s.verdict, verdictReason: s.verdictReason, termEnd: s.termEnd, endedAt: s.endedAt, ends: s.ends, early: s.early, updatedAt: s.updatedAt, stale: s.stale });
    }).catch(function () { /* keep server-rendered values */ });
  }

  // Lazy Polymarket embeds: swap the placeholder for an iframe when scrolled near.
  function mountEmbed(fig) {
    if (fig.dataset.mounted) return;
    fig.dataset.mounted = '1';
    if (!/^https:\/\/embed\.polymarket\.com\//.test(fig.dataset.embed || '')) return;   // only the one allowed embed host
    var f = document.createElement('iframe');
    f.src = fig.dataset.embed;
    f.title = (fig.dataset.label || 'Polymarket') + ' — Polymarket embed';
    f.loading = 'lazy';
    f.setAttribute('referrerpolicy', 'no-referrer');
    // allow-popups-to-escape-sandbox: every link inside the embed is target=_blank → polymarket.com and must open unsandboxed.
    f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox');
    fig.appendChild(f);
  }
  function setupEmbeds() {
    var figs = document.querySelectorAll('figure[data-embed]');
    if (!figs.length) return;
    if (!('IntersectionObserver' in window)) {
      for (var i = 0; i < figs.length; i++) {
        (function (fig) {
          var b = document.createElement('button'); b.type = 'button'; b.textContent = 'load chart';
          b.onclick = function () { b.remove(); mountEmbed(fig); };
          fig.appendChild(b);
        })(figs[i]);
      }
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) { mountEmbed(en.target); io.unobserve(en.target); } });
    }, { rootMargin: '400px 0px' });
    for (var j = 0; j < figs.length; j++) io.observe(figs[j]);
  }

  renderCountdown();
  renderTimes();
  setupEmbeds();
  setInterval(renderCountdown, 60 * 1000);
  setInterval(renderTimes, 60 * 1000);
  setInterval(refresh, 10 * 60 * 1000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { renderCountdown(); renderTimes(); refresh(); } });
})();
