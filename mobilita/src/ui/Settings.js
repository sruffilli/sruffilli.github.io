import { html } from '../../vendor/htm-preact.module.js';
import { doseFor, doseStep, doseUnit } from '../core/settings.js';
import { notificationPermission, requestNotificationPermission } from '../device.js';

const NOTIF_LABELS = {
  granted: 'Promemoria attivi',
  denied: 'Notifiche bloccate',
  default: 'Attiva promemoria',
  unsupported: 'Non disponibili',
};

function Segmented({ label, options, value, onPick }) {
  return html`
    <div>
      <div class="kicker-accent" style="margin-bottom:10px">${label}</div>
      <div class="segmented" role="group" aria-label=${label}>
        ${options.map(
          ([key, text]) => html`
            <button aria-pressed=${value === key} onClick=${() => onPick(key)}>${text}</button>
          `
        )}
      </div>
    </div>
  `;
}

export function Settings({ routines, settings, onChange, onNav, notif, onNotif }) {
  const update = (patch) => onChange({ ...settings, ...patch });

  const setDose = (exercise, value) =>
    update({
      doses: { ...settings.doses, [exercise.id]: Math.max(doseStep(exercise), value) },
    });

  return html`
    <div class="screen">
      <div class="topbar">
        <button class="btn-ghost" onClick=${() => onNav('home')}>‹ Home</button>
        <div class="screen-title">Impostazioni</div>
      </div>

      <div class="scroll">
        <div class="settings">
          <div class="setting-row">
            <div style="flex:1">
              <div class="setting-name">Protezione spalla</div>
              <div class="setting-desc">
                Niente braccio dietro il piano del corpo, niente fine corsa overhead. Variante
                protetta su Open book e World's Greatest Stretch.
              </div>
            </div>
            <button
              class="switch"
              aria-pressed=${settings.shoulder}
              aria-label="Protezione spalla"
              onClick=${() => update({ shoulder: !settings.shoulder })}
            >
              <span></span>
            </button>
          </div>

          <div>
            <div class="kicker-accent" style="margin-bottom:10px">Promemoria Blocco A</div>
            <div class="time-row">
              <input
                type="time"
                value=${settings.reminders[0]}
                aria-label="Primo promemoria"
                onChange=${(e) => update({ reminders: [e.target.value, settings.reminders[1]] })}
              />
              <input
                type="time"
                value=${settings.reminders[1]}
                aria-label="Secondo promemoria"
                onChange=${(e) => update({ reminders: [settings.reminders[0], e.target.value] })}
              />
              <button
                onClick=${() => requestNotificationPermission().then(onNotif)}
                disabled=${notif === 'unsupported'}
              >
                ${NOTIF_LABELS[notif] || NOTIF_LABELS.default}
              </button>
            </div>
            <div class="note">
              Su iPhone le notifiche funzionano solo con l'app aggiunta alla schermata Home (iOS
              16.4+). Senza notifiche resta il conteggio "Oggi: A ✗✗" in home.
            </div>
          </div>

          <${Segmented}
            label="Audio"
            options=${[
              ['beep', 'Beep'],
              ['voice', 'Voce'],
              ['off', 'Off'],
            ]}
            value=${settings.audio}
            onPick=${(audio) => update({ audio })}
          />

          <${Segmented}
            label="Pausa tra esercizi"
            options=${[
              [5, '5 s'],
              [8, '8 s'],
              [10, '10 s'],
            ]}
            value=${settings.rest}
            onPick=${(rest) => update({ rest })}
          />

          <div>
            <div class="kicker-accent" style="margin-bottom:4px">Ripetizioni e durate</div>
            ${routines.blocks.flatMap((block) =>
              block.exercises.map((exercise) => {
                const value = doseFor(exercise, settings, 'warmup', block);
                const step = doseStep(exercise);
                return html`
                  <div class="dose-row">
                    <div class="dose-name">
                      <div>${exercise.name}</div>
                      <div class="dose-block">
                        ${block.label}${exercise.sides ? ' · per lato' : ''}
                      </div>
                    </div>
                    <button
                      class="stepper"
                      aria-label=${`Diminuisci ${exercise.name}`}
                      onClick=${() => setDose(exercise, value - step)}
                    >
                      −
                    </button>
                    <div class="dose-value">${value} ${doseUnit(exercise)}</div>
                    <button
                      class="stepper"
                      aria-label=${`Aumenta ${exercise.name}`}
                      onClick=${() => setDose(exercise, value + step)}
                    >
                      +
                    </button>
                  </div>
                `;
              })
            )}
            <button class="btn-ghost" style="margin-top:10px" onClick=${() => update({ doses: {} })}>
              Ripristina valori predefiniti
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
}
