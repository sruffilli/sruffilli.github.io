// Mobilità — root component and screen routing.

import { html, render, useState, useEffect } from './vendor/htm-preact.module.js';
import { Home } from './src/ui/Home.js';
import { Player } from './src/ui/Player.js';
import { Summary } from './src/ui/Summary.js';
import { History } from './src/ui/History.js';
import { Settings } from './src/ui/Settings.js';
import { mergeLogs, dueReminder } from './src/core/log.js';
import {
  loadSettings,
  saveSettings,
  loadLog,
  saveLog,
  primeAudio,
  notificationPermission,
  showReminder,
} from './src/device.js';

function App({ routines }) {
  const [screen, setScreen] = useState('home');
  const [settings, setSettings] = useState(loadSettings);
  const [log, setLog] = useState(loadLog);
  const [mode, setMode] = useState('warmup');
  const [active, setActive] = useState(null); // { blockId, mode }
  const [entry, setEntry] = useState(null);
  const [notif, setNotif] = useState(notificationPermission);

  function changeSettings(next) {
    saveSettings(next);
    setSettings(next);
  }

  function pushLog(next) {
    saveLog(next);
    setLog(next);
  }

  function start(blockId) {
    primeAudio(); // must run inside the tap: iOS unlocks audio on gesture only
    setActive({ blockId, mode: blockId === 'B' ? mode : 'warmup' });
    setScreen('player');
  }

  function finish(sessionEntry) {
    const next = [sessionEntry, ...log];
    pushLog(next);
    setEntry(sessionEntry);
    setActive(null);
    setScreen('summary');
  }

  // Block A reminder: no push server exists, so the best we can do is check
  // whenever the app becomes visible. README §Promemoria documents the limits.
  useEffect(() => {
    const check = () => {
      if (document.visibilityState !== 'visible') return;
      const due = dueReminder(log, settings.reminders);
      if (due) {
        showReminder(`Blocco A: ${due.done}/${due.target} oggi. 3 minuti alla scrivania.`);
      }
    };
    check();
    document.addEventListener('visibilitychange', check);
    return () => document.removeEventListener('visibilitychange', check);
  }, [log, settings.reminders]);

  if (screen === 'player' && active) {
    const block = routines.blocks.find((b) => b.id === active.blockId);
    return html`
      <${Player}
        key=${active.blockId + active.mode + log.length}
        block=${block}
        settings=${settings}
        mode=${active.mode}
        onFinish=${finish}
        onQuit=${() => {
          setActive(null);
          setScreen('home');
        }}
      />
    `;
  }

  if (screen === 'summary' && entry) {
    return html`
      <${Summary}
        entry=${entry}
        routines=${routines}
        log=${log}
        onHome=${() => setScreen('home')}
      />
    `;
  }

  if (screen === 'history') {
    return html`
      <${History}
        routines=${routines}
        log=${log}
        onNav=${setScreen}
        onImport=${(imported) => pushLog(mergeLogs(log, imported))}
      />
    `;
  }

  if (screen === 'settings') {
    return html`
      <${Settings}
        routines=${routines}
        settings=${settings}
        onChange=${changeSettings}
        onNav=${setScreen}
        notif=${notif}
        onNotif=${setNotif}
      />
    `;
  }

  return html`
    <${Home}
      routines=${routines}
      settings=${settings}
      log=${log}
      mode=${mode}
      onMode=${setMode}
      onStart=${start}
      onNav=${setScreen}
    />
  `;
}

fetch('./routines.json')
  .then((r) => r.json())
  .then((routines) => {
    render(html`<${App} routines=${routines} />`, document.getElementById('app'));
  })
  .catch((err) => {
    document.getElementById('app').innerHTML =
      '<div style="padding:32px;font-size:15px">Impossibile caricare le routine. ' +
      'Ricarica la pagina.</div>';
    console.error(err);
  });

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
