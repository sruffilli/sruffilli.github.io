// Turning a routine block into the flat list of timed segments the player walks.

import { doseFor } from './settings.js';

export const SIDES = ['Sinistra', 'Destra'];

/** Seconds one repetition lasts: hold+release, or the plain cadence. */
export function perRepSec(exercise) {
  if (exercise.kind !== 'reps') return 0;
  return exercise.holdSec ? exercise.holdSec + (exercise.restSec || 0) : exercise.cadenceSec;
}

/**
 * Flatten a block into segments.
 *
 * One segment per exercise *per side*, plus a `rest` segment before every
 * exercise except the first. No rest between the two sides of the same
 * exercise, and none before the first exercise — the handoff is explicit.
 *
 * A rest segment carries the *upcoming* exercise, so the player can show
 * "PROSSIMO ESERCIZIO — <name>" while it counts down.
 */
export function buildSegments(block, settings, mode) {
  const segments = [];
  const restSec = settings.rest != null ? settings.rest : 8;

  block.exercises.forEach((exercise, exIndex) => {
    const dose = doseFor(exercise, settings, mode, block);
    const per = perRepSec(exercise);
    const totalSec = exercise.kind === 'reps' ? dose * per : dose;

    if (exIndex > 0) {
      segments.push({
        kind: 'rest',
        exercise, // the one coming up
        exIndex,
        side: null,
        totalSec: restSec,
        reps: 0,
        perSec: 1,
        extraSec: 0,
      });
    }

    const sides = exercise.sides ? SIDES : [null];
    sides.forEach((side) => {
      segments.push({
        kind: exercise.kind,
        exercise,
        exIndex,
        side,
        totalSec,
        reps: exercise.kind === 'reps' ? dose : 0,
        perSec: per || 1,
        extraSec: 0,
      });
    });
  });

  return segments;
}

/** Total seconds a block takes as configured (used for the home card kicker). */
export function blockDurationSec(block, settings, mode) {
  return buildSegments(block, settings, mode).reduce((sum, s) => sum + s.totalSec, 0);
}

/**
 * Phase label inside a repetition.
 *
 *  - hold exercises: `holdLabel` ("Tieni"/"Giù") then "Rilascia"
 *  - cadence exercises: "Esegui", then "Torna" for the last 1.5 s
 *  - timed exercises: no phase
 *
 * `solid` drives the pill styling: filled for the working phase,
 * outline-only for the release phase.
 */
export function phaseFor(segment, elapsedSec) {
  if (segment.kind !== 'reps') return null;
  const within = elapsedSec % segment.perSec;
  const ex = segment.exercise;
  if (ex.holdSec) {
    return within < ex.holdSec
      ? { label: ex.holdLabel || 'Tieni', solid: true }
      : { label: 'Rilascia', solid: false };
  }
  return within < segment.perSec - 1.5
    ? { label: 'Esegui', solid: true }
    : { label: 'Torna', solid: false };
}

/** 1-based number of the repetition currently being performed. */
export function currentRep(segment, elapsedSec) {
  if (segment.kind !== 'reps') return 0;
  return Math.min(segment.reps, Math.floor(elapsedSec / segment.perSec) + 1);
}
