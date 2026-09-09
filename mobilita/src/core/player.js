// The player state machine. Pure: `tick`/`advance`/`back` take a state and
// return a new state plus a list of events. The browser layer (audio, speech,
// vibration, wake lock) only reacts to events — which is what makes the whole
// timing behaviour unit-testable in Node.

import { buildSegments } from './segments.js';

/**
 * Events emitted:
 *   { type: 'rep' }                      – a repetition started (short tick)
 *   { type: 'countdown', secondsLeft }   – 3, 2, 1 before a segment ends
 *   { type: 'bell' }                     – an exercise/side finished
 *   { type: 'enter', segment, previous } – a new segment started
 *   { type: 'finish' }                   – the session is over
 */

export function createPlayer(block, settings, mode, now = Date.now()) {
  const segments = buildSegments(block, settings, mode);
  return {
    blockId: block.id,
    mode,
    segments,
    index: 0,
    elapsedMs: 0,
    paused: false,
    skipped: {},
    startedAt: now,
    lastCountdownSec: null,
    lastRep: 0,
    finished: false,
  };
}

export function currentSegment(state) {
  return state.segments[state.index];
}

export function segmentTotalSec(segment) {
  return segment.totalSec + segment.extraSec;
}

/** Seconds still to run in the current segment (never negative). */
export function remainingSec(state) {
  const total = segmentTotalSec(currentSegment(state));
  return Math.max(0, total - state.elapsedMs / 1000);
}

/** 0..1 progress of the current segment, for the ring. */
export function progress(state) {
  const total = segmentTotalSec(currentSegment(state));
  if (!total) return 1;
  return Math.min(1, state.elapsedMs / 1000 / total);
}

/**
 * What to say when moving from `previous` to `next`.
 * Returns null when there is nothing worth announcing.
 */
export function announcementFor(previous, next) {
  if (!next) return null;
  if (next.kind === 'rest') return 'Riposo. Prossimo: ' + next.exercise.name;
  if (previous && previous.kind !== 'rest' && previous.exercise === next.exercise) {
    return 'Cambio lato, ' + String(next.side).toLowerCase();
  }
  return next.exercise.name + (next.side ? ', ' + String(next.side).toLowerCase() : '');
}

/**
 * Move to the next segment.
 * `skipped` marks the segment being left as skipped (only real exercises
 * count — skipping a rest is just impatience, not a missed exercise).
 */
export function advance(state, { skipped = false, silent = false } = {}) {
  const events = [];
  const leaving = state.segments[state.index];
  const skippedMap = { ...state.skipped };
  if (skipped && leaving.kind !== 'rest') skippedMap[state.index] = true;

  if (leaving.kind !== 'rest' && !silent) events.push({ type: 'bell' });

  if (state.index + 1 >= state.segments.length) {
    if (!silent) events.push({ type: 'finish' });
    return { state: { ...state, skipped: skippedMap, finished: true }, events };
  }

  const next = state.segments[state.index + 1];
  if (!silent) events.push({ type: 'enter', segment: next, previous: leaving });

  return {
    state: {
      ...state,
      index: state.index + 1,
      elapsedMs: 0,
      lastCountdownSec: null,
      lastRep: 0,
      skipped: skippedMap,
    },
    events,
  };
}

/**
 * Advance the clock by `dtMs`.
 *
 * Crosses as many segment boundaries as the elapsed time demands — a phone
 * that slept for a minute lands where it really should — but only the final
 * transition makes a sound, so catching up does not machine-gun the speaker.
 */
export function tick(state, dtMs) {
  if (state.finished || state.paused) return { state, events: [] };

  let cur = { ...state, elapsedMs: state.elapsedMs + dtMs };
  const events = [];
  let guard = 0;

  while (!cur.finished && guard++ < 1000) {
    const segment = cur.segments[cur.index];
    const totalMs = segmentTotalSec(segment) * 1000;

    if (cur.elapsedMs < totalMs) break;

    const overshoot = cur.elapsedMs - totalMs;
    const stepped = advance(cur, { silent: true });
    cur = stepped.state;
    if (cur.finished) {
      events.push({ type: 'bell' }, { type: 'finish' });
      return { state: cur, events };
    }
    cur.elapsedMs = overshoot;
    // Only the transition we actually land on is announced.
    events.length = 0;
    events.push({ type: 'bell' });
    events.push({
      type: 'enter',
      segment: cur.segments[cur.index],
      previous: segment,
    });
  }

  if (cur.finished) return { state: cur, events };

  const segment = cur.segments[cur.index];
  const totalMs = segmentTotalSec(segment) * 1000;
  const elapsedSec = cur.elapsedMs / 1000;

  // 3-2-1 before the end of any segment, rests included.
  const secondsLeft = Math.ceil((totalMs - cur.elapsedMs) / 1000);
  if (secondsLeft <= 3 && secondsLeft >= 1 && secondsLeft !== cur.lastCountdownSec) {
    events.push({ type: 'countdown', secondsLeft });
    cur.lastCountdownSec = secondsLeft;
  }

  // One tick per repetition.
  if (segment.kind === 'reps') {
    const rep = Math.floor(elapsedSec / segment.perSec);
    if (rep !== cur.lastRep && rep < segment.reps) {
      events.push({ type: 'rep' });
      cur.lastRep = rep;
    }
  }

  return { state: cur, events };
}

/**
 * "Indietro": restart the current segment if it is already under way
 * (> 2 s in), otherwise step back to the previous one.
 */
export function back(state) {
  const restartOnly = state.elapsedMs > 2000 || state.index === 0;
  const index = restartOnly ? state.index : state.index - 1;
  const next = {
    ...state,
    index,
    elapsedMs: 0,
    lastCountdownSec: null,
    lastRep: 0,
  };
  return {
    state: next,
    events: [{ type: 'enter', segment: next.segments[index], previous: null }],
  };
}

/** "+10 s" — only meaningful on timed segments. */
export function addTime(state, seconds = 10) {
  return {
    ...state,
    segments: state.segments.map((s, i) =>
      i === state.index ? { ...s, extraSec: s.extraSec + seconds } : s
    ),
  };
}

export function canAddTime(state) {
  return currentSegment(state).kind === 'time';
}

export function togglePause(state) {
  return { ...state, paused: !state.paused };
}

/**
 * Build the log entry for a finished session.
 *
 * An exercise counts as skipped only when *every* one of its sides was
 * skipped: bailing out of the left side but doing the right one is still
 * work done, and the log should say so.
 */
export function summarize(state, endedAt = Date.now()) {
  const done = new Set();
  const skipped = new Set();
  state.segments.forEach((segment, i) => {
    if (segment.kind === 'rest') return;
    if (state.skipped[i]) skipped.add(segment.exIndex);
    else done.add(segment.exIndex);
  });
  done.forEach((i) => skipped.delete(i));

  return {
    at: new Date(endedAt).toISOString(),
    block: state.blockId,
    mode: state.mode,
    durationMs: endedAt - state.startedAt,
    done: done.size,
    skipped: skipped.size,
  };
}
