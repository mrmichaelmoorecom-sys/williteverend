import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickJob, STALE_HOURLY_MS, STALE_NEWS_MS } from '../src/lib/schedule.js';

const NOW = Date.parse('2026-09-22T06:30:00Z');
const iso = (ms) => new Date(NOW - ms).toISOString();

test('pickJob: cold start → no heavy job; fresh deploy converges approval → election2028 → news', () => {
  assert.equal(pickJob(null, NOW), null);
  const prev = { approval: null, election2028: null, sources: { news: { ok: false, at: null } } };
  assert.equal(pickJob(prev, NOW), 'approval');
  prev.jobs = { approval: iso(0) };
  assert.equal(pickJob(prev, NOW), 'election2028');
  prev.jobs.election2028 = iso(0);
  assert.equal(pickJob(prev, NOW), 'news');
  prev.jobs.news = iso(0);
  assert.equal(pickJob(prev, NOW), null);
});

test('pickJob: staleness thresholds and priority; a failing job cannot starve the others', () => {
  const fresh = { jobs: { approval: iso(0), election2028: iso(0), news: iso(0) } };
  assert.equal(pickJob({ ...fresh, jobs: { ...fresh.jobs, news: iso(STALE_NEWS_MS + 1) } }, NOW), 'news');
  assert.equal(pickJob({ ...fresh, jobs: { ...fresh.jobs, news: iso(STALE_NEWS_MS - 1) } }, NOW), null);
  assert.equal(pickJob({ ...fresh, jobs: { ...fresh.jobs, election2028: iso(STALE_HOURLY_MS + 1), news: iso(STALE_NEWS_MS + 1) } }, NOW), 'election2028');
  assert.equal(pickJob({ ...fresh, jobs: { ...fresh.jobs, approval: iso(STALE_HOURLY_MS + 1), election2028: iso(STALE_HOURLY_MS + 1) } }, NOW), 'approval');
  // election2028 attempted 5 min ago but failed (data `at` still 2 h old): the attempt time wins → news runs
  const failing = { jobs: { approval: iso(0), election2028: iso(5 * 60e3), news: iso(11 * 60e3) }, election2028: { at: iso(2 * 3600e3) } };
  assert.equal(pickJob(failing, NOW), 'news');
});

test('pickJob: snapshots written before `jobs` existed fall back to the data timestamps', () => {
  const old = { approval: { updatedAt: iso(10 * 60e3) }, election2028: { at: iso(10 * 60e3) }, sources: { news: { at: iso(3 * 60e3) } } };
  assert.equal(pickJob(old, NOW), null);
  old.approval.updatedAt = iso(STALE_HOURLY_MS + 1);
  assert.equal(pickJob(old, NOW), 'approval');
});
