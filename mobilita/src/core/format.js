// Pure formatting helpers. No DOM, no browser APIs — unit-tested in Node.

/** Local calendar day key, e.g. "2026-09-09". Local time on purpose: a
 *  session at 23:50 belongs to that evening, not to the next UTC day. */
export function dayKey(date) {
  const d = new Date(date);
  return (
    d.getFullYear() +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0')
  );
}

/** Milliseconds → "m:ss". */
export function fmtMs(ms) {
  const s = Math.round(ms / 1000);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

/** Seconds → "m:ss" (used for estimated block duration). */
export function fmtSec(sec) {
  return fmtMs(sec * 1000);
}

/**
 * Dose caption shown under the exercise name in the player,
 * e.g. "30 S PER LATO", "10 RIP × 5 S TENUTA", "8 RIP PER LATO", "10 RIP LENTE".
 * Rendered uppercase by CSS; kept in natural case here so it is readable
 * in tests and in any non-uppercased context.
 */
export function doseLabel(exercise, value) {
  if (exercise.kind === 'time') {
    return value + ' s' + (exercise.sides ? ' per lato' : '');
  }
  if (exercise.holdSec) {
    return value + ' rip × ' + exercise.holdSec + ' s tenuta';
  }
  return value + ' rip' + (exercise.sides ? ' per lato' : ' lente');
}
