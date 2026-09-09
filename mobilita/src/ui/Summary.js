import { html } from '../../vendor/htm-preact.module.js';
import { fmtMs } from '../core/format.js';
import { todayCounts, checkMarks, streak } from '../core/log.js';

export function Summary({ entry, routines, log, onHome }) {
  const block = routines.blocks.find((b) => b.id === entry.block);
  const counts = todayCounts(log);
  const targets = Object.fromEntries(routines.blocks.map((b) => [b.id, b.targetPerDay]));

  return html`
    <div class="screen">
      <div class="summary">
        <div>
          <div class="kicker-accent">Sessione completata</div>
          <div class="summary-title">${block.label} · ${block.title}</div>
        </div>

        <div class="summary-grid">
          <div>
            <div class="kicker">Durata</div>
            <div class="value">${fmtMs(entry.durationMs)}</div>
          </div>
          <div>
            <div class="kicker">Completati</div>
            <div class="value">${entry.done}</div>
          </div>
          <div>
            <div class="kicker">Saltati</div>
            <div class="value">${entry.skipped}</div>
          </div>
        </div>

        <div style="font-size:14px;color:rgba(242,242,243,.7)">
          Registrata nel log. Oggi: A ${checkMarks(counts.A, targets.A)} · B
          ${' '}${checkMarks(counts.B, targets.B)} · streak ${streak(log)} gg.
        </div>

        <button class="btn-primary" onClick=${onHome}>Torna alla home</button>
      </div>
    </div>
  `;
}
