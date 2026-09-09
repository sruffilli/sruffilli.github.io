// Session log: counting, streaks, and import/export merging. Pure.

import { dayKey } from './format.js';

/** How many sessions of each block were logged today. */
export function todayCounts(log, now = Date.now()) {
  const today = dayKey(now);
  const counts = { A: 0, B: 0 };
  log.forEach((entry) => {
    if (dayKey(entry.at) === today && counts[entry.block] != null) counts[entry.block] += 1;
  });
  return counts;
}

/** "✓✗" for a target of 2, "✓" / "✗" for a target of 1. */
export function checkMarks(count, target) {
  let out = '';
  for (let i = 1; i <= target; i += 1) out += count >= i ? '✓' : '✗';
  return out;
}

/**
 * Consecutive days with at least one session, counting back from today —
 * or from yesterday when today is still empty, so the streak does not appear
 * broken at 9 in the morning.
 */
export function streak(log, now = Date.now()) {
  const days = new Set(log.map((e) => dayKey(e.at)));
  if (!days.size) return 0;
  const cursor = new Date(now);
  if (!days.has(dayKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  let n = 0;
  while (days.has(dayKey(cursor))) {
    n += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return n;
}

/** Keep only entries that look like sessions; drop anything malformed. */
export function isValidEntry(entry) {
  return !!(
    entry &&
    typeof entry === 'object' &&
    typeof entry.at === 'string' &&
    !Number.isNaN(Date.parse(entry.at)) &&
    (entry.block === 'A' || entry.block === 'B')
  );
}

/**
 * Merge an imported log into the existing one: unique by `at`, newest first.
 * Existing entries win a collision — the local device is the source of truth
 * for its own history.
 */
export function mergeLogs(existing, imported) {
  const seen = new Set();
  return [...existing, ...(Array.isArray(imported) ? imported : [])]
    .filter((entry) => {
      if (!isValidEntry(entry) || seen.has(entry.at)) return false;
      seen.add(entry.at);
      return true;
    })
    .sort((a, b) => b.at.localeCompare(a.at));
}

/**
 * Should a Block A reminder fire?
 * True when a configured reminder time has passed today and Block A is still
 * below its daily target. Pure so the rule can be tested without clocks.
 */
export function dueReminder(log, reminders, now = Date.now(), target = 2) {
  const done = todayCounts(log, now).A;
  if (done >= target) return null;
  const d = new Date(now);
  const minutesNow = d.getHours() * 60 + d.getMinutes();
  let latest = null;
  (reminders || []).forEach((hhmm) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
    if (!m) return;
    const minutes = Number(m[1]) * 60 + Number(m[2]);
    if (minutes <= minutesNow && (latest === null || minutes > latest.minutes)) {
      latest = { time: hhmm, minutes };
    }
  });
  return latest ? { time: latest.time, done, target } : null;
}
