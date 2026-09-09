import { html } from '../../vendor/htm-preact.module.js';
import { fmtMs } from '../core/format.js';
import { streak } from '../core/log.js';
import { downloadJson, readJsonFile } from '../device.js';

export function History({ routines, log, onNav, onImport }) {
  const labels = Object.fromEntries(routines.blocks.map((b) => [b.id, b.label]));

  return html`
    <div class="screen">
      <div class="topbar">
        <button class="btn-ghost" onClick=${() => onNav('home')}>‹ Home</button>
        <div class="screen-title">Storico</div>
      </div>

      <div class="stats">
        <div>
          <div class="kicker">Sessioni</div>
          <div class="stat">${log.length}</div>
        </div>
        <div>
          <div class="kicker">Streak</div>
          <div class="stat">${streak(log)} gg</div>
        </div>
      </div>

      <div class="scroll" style="padding:16px 24px 0">
        ${log.length === 0 &&
        html`<div class="muted" style="font-size:14px;padding:24px 0">
          Nessuna sessione ancora. Premi Start sulla home.
        </div>`}
        ${log.map((entry) => {
          const d = new Date(entry.at);
          return html`
            <div class="log-row">
              <div class="log-date">
                ${d.toLocaleDateString('it-IT', {
                  weekday: 'short',
                  day: 'numeric',
                  month: 'short',
                })}
              </div>
              <div class="log-time">
                ${d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}
              </div>
              <div style="margin-left:auto">
                ${labels[entry.block] || entry.block} · ${fmtMs(entry.durationMs)}
              </div>
              <div class="log-mode">
                ${entry.block === 'B' ? (entry.mode === 'evening' ? 'Serale' : 'Warm-up') : ''}
              </div>
            </div>
          `;
        })}
      </div>

      <div class="io-buttons">
        <button class="btn-outline" onClick=${() => downloadJson('stretching-log.json', log)}>
          Esporta JSON
        </button>
        <label class="file-label">
          Importa JSON
          <input
            type="file"
            accept=".json,application/json"
            onChange=${(e) => {
              const file = e.target.files && e.target.files[0];
              if (!file) return;
              readJsonFile(file)
                .then(onImport)
                .catch(() => {})
                .then(() => {
                  e.target.value = '';
                });
            }}
          />
        </label>
      </div>
    </div>
  `;
}
