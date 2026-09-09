// Everything that touches a browser API lives here: audio, speech, vibration,
// wake lock, storage, notifications. Kept out of core/ so core stays testable.

import { SETTINGS_KEY, LOG_KEY, normalizeSettings } from './core/settings.js';

/* ── storage ──────────────────────────────────────────────────────────── */

export function loadSettings() {
  try {
    return normalizeSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY)));
  } catch {
    return normalizeSettings(null);
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* private mode / quota — the app keeps working, it just forgets */
  }
}

export function loadLog() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LOG_KEY));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveLog(log) {
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(log));
  } catch {
    /* ignore */
  }
}

/* ── audio ────────────────────────────────────────────────────────────── */

let audioCtx = null;

/** iOS only allows an AudioContext created/resumed inside a user gesture. */
export function primeAudio() {
  try {
    if (!audioCtx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (Ctor) audioCtx = new Ctor();
    }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  } catch {
    audioCtx = null;
  }
  return audioCtx;
}

function tone(freq, durationSec, delaySec = 0) {
  const ctx = audioCtx;
  if (!ctx) return;
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const t0 = ctx.currentTime + delaySec;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.4, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + durationSec);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + durationSec + 0.05);
  } catch {
    /* audio is a nicety, never a failure */
  }
}

function vibrate(pattern) {
  try {
    if (navigator.vibrate) navigator.vibrate(pattern);
  } catch {
    /* not supported — no-op by design */
  }
}

function speak(text) {
  try {
    if (!window.speechSynthesis) return;
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = 'it-IT';
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
  } catch {
    /* ignore */
  }
}

/**
 * Play one player event. `announcement` is the text computed by
 * core/player.announcementFor — passed in rather than derived here.
 */
export function playEvent(event, settings, announcement) {
  const audio = settings.audio;
  if (event.type === 'rep') {
    if (audio !== 'off') tone(520, 0.06);
    return;
  }
  if (event.type === 'countdown') {
    if (audio !== 'off') tone(660, 0.1);
    return;
  }
  if (event.type === 'bell' || event.type === 'finish') {
    if (audio !== 'off') {
      tone(1046, 0.5);
      tone(1568, 0.7, 0.05);
    }
    vibrate([120, 60, 120]);
    return;
  }
  if (event.type === 'enter') {
    if (audio !== 'off') tone(880, 0.12);
    vibrate(80);
    if (audio === 'voice' && announcement) speak(announcement);
  }
}

/* ── wake lock ────────────────────────────────────────────────────────── */

let wakeLock = null;

export async function requestWakeLock() {
  try {
    if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen');
  } catch {
    wakeLock = null; // Safari < 16.4 and any denial: documented limitation
  }
}

export function releaseWakeLock() {
  try {
    if (wakeLock) wakeLock.release();
  } catch {
    /* ignore */
  }
  wakeLock = null;
}

export function hasWakeLock() {
  return !!wakeLock;
}

/* ── notifications ────────────────────────────────────────────────────── */

export function notificationPermission() {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

export async function requestNotificationPermission() {
  if (typeof Notification === 'undefined') return 'unsupported';
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

/**
 * Show a local reminder. There is no push server, so this can only fire while
 * the app is open (or being opened) — see README §Promemoria for the iOS
 * limits this cannot work around.
 */
export async function showReminder(body) {
  if (notificationPermission() !== 'granted') return false;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const options = { body, tag: 'stretch-block-a', icon: './icons/icon-192.png' };
    if (reg) await reg.showNotification('Blocco A', options);
    else new Notification('Blocco A', options);
    return true;
  } catch {
    return false;
  }
}

/* ── files ────────────────────────────────────────────────────────────── */

export function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function readJsonFile(file) {
  return file.text().then((text) => JSON.parse(text));
}
