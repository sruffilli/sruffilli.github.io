import { html } from '../../vendor/htm-preact.module.js';
import { blockDurationSec } from '../core/segments.js';
import { todayCounts, checkMarks, streak } from '../core/log.js';

function Card({ block, kicker, description, children, onStart }) {
  return html`
    <div class="card">
      <i>+</i><i>+</i><i>+</i><i>+</i>
      <div class="card-kicker">${kicker}</div>
      <div class="card-title">${block.title}</div>
      <p class="card-desc">${description}</p>
      ${children}
      <button class="btn-primary" onClick=${onStart}>Start</button>
    </div>
  `;
}

export function Home({ routines, settings, log, mode, onMode, onStart, onNav }) {
  const blockA = routines.blocks.find((b) => b.id === 'A');
  const blockB = routines.blocks.find((b) => b.id === 'B');
  const counts = todayCounts(log);
  const minutesA = Math.round(blockDurationSec(blockA, settings, 'warmup') / 60);
  const minutesB = Math.round(blockDurationSec(blockB, settings, mode) / 60);

  return html`
    <div class="screen">
      <div class="topbar">
        <div class="brand">Mobilità</div>
        <button class="btn-ghost" onClick=${() => onNav('history')}>Storico</button>
        <button class="btn-ghost" onClick=${() => onNav('settings')}>Impostazioni</button>
      </div>

      <div class="stats">
        <div>
          <div class="kicker">Oggi</div>
          <div class="stat">
            A ${checkMarks(counts.A, blockA.targetPerDay)} · B
            ${' '}${checkMarks(counts.B, blockB.targetPerDay)}
          </div>
        </div>
        <div>
          <div class="kicker">Streak</div>
          <div class="stat">${streak(log)} gg</div>
        </div>
      </div>

      <div class="cards">
        <${Card}
          block=${blockA}
          kicker=${`Blocco A · ${minutesA} min · 2× al giorno`}
          description="Alla scrivania. Chin tuck, trapezio, elevatore, scapular set. Anche dopo ogni uscita in bici oltre 40 km."
          onStart=${() => onStart('A')}
        />
        <${Card}
          block=${blockB}
          kicker=${`Blocco B · ${minutesB} min · ogni giorno`}
          description="Rachide, anche, retto femorale, caviglie. In modalità Serale le tenute salgono a 50 s."
          onStart=${() => onStart('B')}
        >
          <div class="segmented" role="group" aria-label="Modalità Blocco B">
            <button aria-pressed=${mode === 'warmup'} onClick=${() => onMode('warmup')}>
              Warm-up
            </button>
            <button aria-pressed=${mode === 'evening'} onClick=${() => onMode('evening')}>
              Serale
            </button>
          </div>
        <//>
      </div>

      <div class="footnote">
        Protezione spalla: ${settings.shoulder ? 'ON' : 'OFF'}
      </div>
    </div>
  `;
}
