// Settings shape, defaults, and dose resolution. Pure — no storage here.

export const SETTINGS_KEY = 'stretch.settings';
export const LOG_KEY = 'stretch.log';

export const DEFAULT_SETTINGS = {
  shoulder: true, // "Protezione spalla" — see README §Protezione spalla
  audio: 'beep', // 'beep' | 'voice' | 'off'
  reminders: ['10:30', '15:30'],
  rest: 8, // seconds between exercises
  doses: {}, // { [exerciseId]: number } — overrides of reps or seconds
};

/** Merge stored settings over the defaults, dropping unknown/invalid values. */
export function normalizeSettings(raw) {
  const s = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) };
  s.shoulder = s.shoulder !== false;
  if (!['beep', 'voice', 'off'].includes(s.audio)) s.audio = DEFAULT_SETTINGS.audio;
  if (!Array.isArray(s.reminders) || s.reminders.length !== 2) {
    s.reminders = [...DEFAULT_SETTINGS.reminders];
  }
  if (![5, 8, 10].includes(s.rest)) s.rest = DEFAULT_SETTINGS.rest;
  if (!s.doses || typeof s.doses !== 'object') s.doses = {};
  return s;
}

/**
 * The dose actually used for an exercise: reps for `kind: "reps"`,
 * seconds for `kind: "time"`.
 *
 * Evening mode lengthens static holds (B5, B6) to the block's
 * `modes.evening.staticHoldSec` — but only when the user has no explicit
 * override, so a hand-set dose always wins.
 */
export function doseFor(exercise, settings, mode, block) {
  const override = settings.doses ? settings.doses[exercise.id] : undefined;
  if (exercise.kind === 'time') {
    if (override != null) return override;
    if (mode === 'evening' && exercise.static) {
      const evening = block && block.modes && block.modes.evening;
      if (evening && evening.staticHoldSec) return evening.staticHoldSec;
    }
    return exercise.seconds;
  }
  return override != null ? override : exercise.reps;
}

/** Stepper granularity in Settings: 5 s for holds, 1 rep for reps. */
export function doseStep(exercise) {
  return exercise.kind === 'time' ? 5 : 1;
}

export function doseUnit(exercise) {
  return exercise.kind === 'time' ? 's' : 'rip';
}
