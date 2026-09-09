import { html, useState, useEffect, useRef } from '../../vendor/htm-preact.module.js';
import {
  createPlayer,
  currentSegment,
  segmentTotalSec,
  tick,
  advance,
  back,
  addTime,
  canAddTime,
  togglePause,
  announcementFor,
  summarize,
} from '../core/player.js';
import { phaseFor, currentRep } from '../core/segments.js';
import { doseFor } from '../core/settings.js';
import { doseLabel } from '../core/format.js';
import { playEvent, primeAudio, requestWakeLock, releaseWakeLock } from '../device.js';

const RING_R = 126;
const RING_C = 2 * Math.PI * RING_R;
const TICK_MS = 100;

export function Player({ block, settings, mode, onFinish, onQuit }) {
  const [state, setState] = useState(() => createPlayer(block, settings, mode));
  const ref = useRef(state);
  const finished = useRef(false);

  // Handlers read `ref.current`, never the state captured by this render:
  // Preact batches updates, so two fast taps on Salta would otherwise both
  // act on the same stale segment and only one would count.
  function apply(next, events) {
    ref.current = next;
    setState(next);
    (events || []).forEach(handle);
  }

  function handle(event) {
    if (event.type === 'finish') {
      if (finished.current) return;
      finished.current = true;
      releaseWakeLock();
      onFinish(summarize(ref.current));
      return;
    }
    const announcement =
      event.type === 'enter' ? announcementFor(event.previous, event.segment) : null;
    playEvent(event, settings, announcement);
  }

  // Start: prime audio (must happen in the Start gesture, which is upstream),
  // grab the wake lock, announce the first segment, run the clock.
  useEffect(() => {
    requestWakeLock();
    handle({ type: 'enter', segment: ref.current.segments[0], previous: null });

    let last = performance.now();
    const id = setInterval(() => {
      const now = performance.now();
      const dt = now - last;
      last = now;
      const cur = ref.current;
      if (cur.paused || cur.finished || finished.current) return;
      const stepped = tick(cur, dt);
      apply(stepped.state, stepped.events);
    }, TICK_MS);

    const onVisible = () => {
      if (document.visibilityState === 'visible' && !ref.current.paused) requestWakeLock();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
      releaseWakeLock();
    };
    // eslint-disable-next-line
  }, []);

  const segment = currentSegment(state);
  const exercise = segment.exercise;
  const isRest = segment.kind === 'rest';
  const elapsedSec = state.elapsedMs / 1000;
  const totalSec = segmentTotalSec(segment);
  const remaining = Math.max(0, totalSec - elapsedSec);
  const ratio = totalSec ? Math.min(1, elapsedSec / totalSec) : 1;

  const phase = isRest ? null : phaseFor(segment, elapsedSec);
  const sideLabel = (() => {
    if (isRest) return { text: 'Riposo', cls: 'rest' };
    if (phase && segment.side) {
      return { text: `${phase.label} · ${segment.side}`, cls: phase.solid ? 'solid' : 'hollow' };
    }
    if (phase) return { text: phase.label, cls: phase.solid ? 'solid' : 'hollow' };
    if (segment.side) return { text: segment.side, cls: 'solid' };
    return null;
  })();

  const dose = doseFor(exercise, settings, mode, block);
  const showBanner = !!(settings.shoulder && exercise.protectedVariant);
  const next = state.segments[state.index + 1];
  const bigNumber = segment.kind === 'reps' ? currentRep(segment, elapsedSec) : Math.ceil(remaining);
  const bigCaption = isRest
    ? 'preparati'
    : segment.kind === 'time'
      ? 'secondi'
      : `di ${segment.reps} rip · ${Math.ceil(remaining)} s`;

  return html`
    <div class="screen player" style=${{ background: isRest ? 'var(--bg-rest)' : 'var(--bg)' }}>
      <div class="topbar">
        <button
          class="btn-ghost"
          onClick=${() => {
            releaseWakeLock();
            onQuit();
          }}
        >
          Esci
        </button>
        <div class="player-meta">
          ${block.label}${mode === 'evening' ? ' · Serale' : ''} ·
          ${' '}${segment.exIndex + 1} / ${block.exercises.length}
        </div>
      </div>

      <div class="progress">
        ${block.exercises.map(
          (_, i) =>
            html`<span
              class=${i < segment.exIndex ? 'done' : i === segment.exIndex ? 'current' : ''}
            ></span>`
        )}
      </div>

      <div class="ex-head">
        <div class="ex-kicker">${isRest ? 'Prossimo esercizio' : ''}</div>
        <div class="ex-name">${exercise.name}</div>
        <div class="ex-dose">${doseLabel(exercise, dose)}</div>
      </div>

      <div class="banner-slot">
        ${showBanner &&
        html`<div class="banner">
          <b>Protezione spalla</b>${exercise.protectedVariant}
        </div>`}
      </div>

      <div class="stage">
        <div class="phase-slot">
          ${sideLabel && html`<div class="phase ${sideLabel.cls}">${sideLabel.text}</div>`}
        </div>

        <div class="ring">
          <svg viewBox="0 0 272 272" width="240" height="240" aria-hidden="true">
            <circle
              cx="136"
              cy="136"
              r=${RING_R}
              fill="none"
              stroke="rgba(242,242,243,.15)"
              stroke-width="6"
            />
            <circle
              cx="136"
              cy="136"
              r=${RING_R}
              fill="none"
              stroke=${isRest ? 'rgba(242,242,243,.7)' : 'var(--accent)'}
              stroke-width="6"
              stroke-linecap="butt"
              stroke-dasharray=${`${(RING_C * ratio).toFixed(1)} ${RING_C.toFixed(1)}`}
            />
          </svg>
          <div class="ring-centre">
            <div class="big-number">${bigNumber}</div>
            <div class="big-caption">${bigCaption}</div>
          </div>
        </div>

        <div class="instruction">${exercise.instruction}</div>
      </div>

      <div class="video-link">
        <a href=${exercise.video} target="_blank" rel="noopener">Guarda il video ↗</a>
      </div>

      <div class="controls">
        <button class="btn-outline" onClick=${() => apply(...unpack(back(ref.current)))}>
          Indietro
        </button>
        <button
          class="btn-primary"
          onClick=${() => {
            primeAudio();
            apply(togglePause(ref.current), []);
          }}
        >
          ${state.paused ? 'Riprendi' : 'Pausa'}
        </button>
        <button
          class="btn-outline"
          disabled=${!canAddTime(state)}
          onClick=${() => apply(addTime(ref.current, 10), [])}
        >
          +10 s
        </button>
        <button
          class="btn-outline"
          onClick=${() => apply(...unpack(advance(ref.current, { skipped: true })))}
        >
          Salta
        </button>
      </div>

      <div class="player-footer">
        ${next ? `Prossimo: ${next.exercise.name}${next.side ? ' · ' + next.side : ''}` : 'fine sessione'}
      </div>
    </div>
  `;
}

/** `{state, events}` → the argument pair `apply` wants. */
function unpack(result) {
  return [result.state, result.events];
}
