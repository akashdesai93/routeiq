import { registerPlugin } from '@capacitor/core';
import { summarize, summaryRows, formatDuration } from './summary.js';

// Native side: probe-native/ios/Sources/ProbeNativePlugin. All measuring
// happens there. This page starts and stops it, shows numbers, and runs two
// deliberately "web only" paths so the log shows whether a WebView stays alive
// in the background: a plain 10 s timer, and the community geolocation plugin
// delivering fixes to JavaScript.
const ProbeNative = registerPlugin('ProbeNative');
const BackgroundGeolocation = registerPlugin('BackgroundGeolocation');

const JS_TIMER_MS = 10_000;

const el = (id) => document.getElementById(id);
const state = {
  running: false,
  waiting: false,
  jsSeq: 0,
  lastJsTick: 0,
  nativeFixEvents: 0,
  pluginFixes: 0,
  watcherId: null,
};

function note(message) {
  ProbeNative.jsNote({ message: String(message).slice(0, 200) }).catch(() => {});
}

function setMessage(text, bad = false) {
  el('message').textContent = text;
  el('message').className = bad ? 'bad' : '';
}

function render(status) {
  state.running = Boolean(status.running);
  state.waiting = Boolean(status.waitingForPermission);
  el('start').disabled = state.running || state.waiting;
  el('stop').disabled = !state.running && !state.waiting;
  el('state').textContent = state.running
    ? 'RUNNING'
    : state.waiting
      ? 'WAITING FOR PERMISSION'
      : 'STOPPED';
  el('state').className = state.running ? 'on' : 'off';
  if (!state.running) return;
  const sinceFix = status.secondsSinceFix < 0 ? 'none yet' : `${Math.round(status.secondsSinceFix)} s ago`;
  el('live').textContent =
    `Running ${formatDuration(status.elapsedSeconds)}\n` +
    `Fixes ${status.fixes} (last ${sinceFix})\n` +
    `Spoken ${status.speechStarted} of ${status.speechRequested}, failed ${status.speechFailed}\n` +
    `Fetch ok ${status.fetchOk}, failed ${status.fetchFailed}\n` +
    `Location permission: ${status.auth}\n` +
    `Audio output: ${status.route}`;
}

async function refreshStatus() {
  try {
    render(await ProbeNative.getStatus());
  } catch (error) {
    setMessage(`Native probe not available: ${error?.message ?? error}`, true);
  }
}

async function refreshSummary() {
  try {
    const { text } = await ProbeNative.readLog();
    const rows = summaryRows(summarize(text));
    const table = el('summary');
    table.replaceChildren();
    if (rows.length === 0) {
      el('summaryTitle').textContent = 'No session recorded yet';
      return;
    }
    el('summaryTitle').textContent = state.running ? 'This session so far' : 'Last session';
    for (const row of rows) {
      const tr = document.createElement('tr');
      if (row.bad) tr.className = 'bad';
      const label = document.createElement('th');
      label.textContent = row.label;
      const value = document.createElement('td');
      value.textContent = row.value;
      tr.append(label, value);
      table.append(tr);
    }
  } catch (error) {
    note(`summary failed: ${error?.message ?? error}`);
  }
}

// Second, web-facing location path: the plugin the real app would use.
// Coordinates arrive here but are only counted, never kept.
async function startGeoPluginWatcher() {
  if (state.watcherId !== null) return;
  state.watcherId = 'pending';
  try {
    state.watcherId = await BackgroundGeolocation.addWatcher(
      {
        backgroundMessage: 'RouteIQ Probe is recording a test drive.',
        requestPermissions: false,
        stale: true,
        distanceFilter: 0,
      },
      (location, error) => {
        if (error) {
          note(`geolocation plugin error: ${error.code ?? ''} ${error.message ?? ''}`);
          return;
        }
        if (location) state.pluginFixes += 1;
      },
    );
    note('geolocation plugin watcher added');
  } catch (error) {
    state.watcherId = null;
    note(`geolocation plugin addWatcher failed: ${error?.message ?? error}`);
  }
}

async function stopGeoPluginWatcher() {
  const id = state.watcherId;
  state.watcherId = null;
  if (id === null || id === 'pending') return;
  try {
    await BackgroundGeolocation.removeWatcher({ id });
  } catch (error) {
    note(`geolocation plugin removeWatcher failed: ${error?.message ?? error}`);
  }
}

async function onStart() {
  setMessage('');
  state.jsSeq = 0;
  state.nativeFixEvents = 0;
  state.pluginFixes = 0;
  state.lastJsTick = Date.now();
  try {
    render(await ProbeNative.start());
    if (state.waiting) setMessage('Answer the location question, then the probe starts by itself.');
    else setMessage('Started. You can lock the phone now.');
  } catch (error) {
    setMessage(error?.message ?? String(error), true);
  }
}

async function onStop() {
  try {
    await stopGeoPluginWatcher();
    render(await ProbeNative.stop());
    setMessage('Stopped.');
  } catch (error) {
    setMessage(error?.message ?? String(error), true);
  }
  await refreshSummary();
}

async function onExport() {
  try {
    await ProbeNative.exportLog();
  } catch (error) {
    setMessage(error?.message ?? String(error), true);
  }
}

// The "can a web timer be trusted" experiment. Each fire is written to the
// native log together with how late it was and what the page has received.
function jsTimerFired() {
  const now = Date.now();
  const sinceLastMs = state.lastJsTick ? now - state.lastJsTick : -1;
  state.lastJsTick = now;
  if (!state.running) return;
  state.jsSeq += 1;
  ProbeNative.jsHeartbeat({
    seq: state.jsSeq,
    sinceLastMs,
    nativeFixEvents: state.nativeFixEvents,
    pluginFixes: state.pluginFixes,
    hidden: document.hidden,
  }).catch(() => {});
}

async function main() {
  el('start').addEventListener('click', onStart);
  el('stop').addEventListener('click', onStop);
  el('export').addEventListener('click', onExport);

  window.addEventListener('error', (event) => note(`js error: ${event.message}`));
  window.addEventListener('unhandledrejection', (event) =>
    note(`js rejection: ${event.reason?.message ?? event.reason}`),
  );
  document.addEventListener('visibilitychange', () => {
    note(`page ${document.hidden ? 'hidden' : 'visible'}`);
    if (!document.hidden) {
      refreshStatus();
      refreshSummary();
    }
  });

  await ProbeNative.addListener('fix', () => {
    state.nativeFixEvents += 1;
  });

  setInterval(jsTimerFired, JS_TIMER_MS);
  setInterval(async () => {
    await refreshStatus();
    if (state.running) startGeoPluginWatcher();
  }, 1000);
  setInterval(() => {
    if (state.running && !document.hidden) refreshSummary();
  }, 15_000);

  await refreshStatus();
  await refreshSummary();
}

main().catch((error) => setMessage(`Startup failed: ${error?.message ?? error}`, true));
