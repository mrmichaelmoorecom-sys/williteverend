// Cron scheduling: every tick refreshes the markets (cheap); at most ONE heavy job runs per invocation so a
// single run stays inside the Workers Free plan's 10 ms CPU budget (per HTTP request AND per cron invocation).
// Jobs: approval (NYT + Silver Bulletin CSVs), election2028 (the 445 KB Polymarket event + Kalshi list +
// monthly-market discovery), news (four RSS feeds). Progress persists after every job, so a fresh deploy
// converges within ~3 ticks of the */10 trigger.

export const JOBS = ['approval', 'election2028', 'news'];
export const STALE_HOURLY_MS = 55 * 60e3;   // approval + election2028 are "hourly"
export const STALE_NEWS_MS = 10 * 60e3;     // news every tick when nothing hourly is due

const age = (iso, now) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? now - t : Infinity; };

/**
 * Pick the one heavy job that is due, in priority order approval → election2028 → news, or null.
 * `prev.jobs[job]` is the last ATTEMPT time (so a failing job cannot starve the others); older
 * snapshots without `jobs` fall back to the data timestamps.
 */
export function pickJob(prev, now = Date.now()) {
  if (!prev) return null;   // cold start: markets only
  const jobs = prev.jobs || {};
  const lastAt = {
    approval: jobs.approval || (prev.approval && prev.approval.updatedAt) || null,
    election2028: jobs.election2028 || (prev.election2028 && prev.election2028.at) || null,
    news: jobs.news || (prev.sources && prev.sources.news && prev.sources.news.at) || null,
  };
  if (age(lastAt.approval, now) > STALE_HOURLY_MS) return 'approval';
  if (age(lastAt.election2028, now) > STALE_HOURLY_MS) return 'election2028';
  if (age(lastAt.news, now) > STALE_NEWS_MS) return 'news';
  return null;
}
