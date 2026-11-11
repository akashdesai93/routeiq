// Turns the probe's log text into the numbers shown after a drive.
// Pure functions, no DOM and no native calls, so they can be tested with Node.

/** @typedef {{ t: number, event: string, details: string }} LogLine */

/** @param {string} text @returns {LogLine[]} */
export function parseLog(text) {
  const lines = [];
  for (const raw of text.split('\n')) {
    if (!raw) continue;
    const [stamp, event, ...rest] = raw.split('\t');
    const t = Date.parse(stamp);
    if (!event || Number.isNaN(t)) continue;
    lines.push({ t, event, details: rest.join('\t') });
  }
  return lines;
}

/** Reads `key=value` out of a details string. */
export function field(details, key) {
  const match = new RegExp(`(?:^|\\s)${key}=("[^"]*"|\\S+)`).exec(details);
  return match ? match[1] : undefined;
}

/**
 * Longest silence for one kind of event, counting the stretch before the first
 * one and after the last one. Without the edges, "spoke twice then never
 * again" would look like a perfect result.
 */
function longestGap(times, start, end) {
  const points = [start, ...times, end];
  let seconds = 0;
  let at = start;
  for (let i = 1; i < points.length; i++) {
    const gap = (points[i] - points[i - 1]) / 1000;
    if (gap > seconds) {
      seconds = gap;
      at = points[i - 1];
    }
  }
  return { seconds, at };
}

/**
 * Summarises the last session in the log.
 * @param {string} text
 */
export function summarize(text) {
  const all = parseLog(text);
  let startIndex = -1;
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].event === 'SESSION_START') {
      startIndex = i;
      break;
    }
  }
  if (startIndex < 0) return null;

  let lines = all.slice(startIndex);
  const stopIndex = lines.findIndex((l) => l.event === 'SESSION_STOP');
  const stopped = stopIndex >= 0;
  // A fresh launch after the start means the app was killed mid-session.
  const relaunchIndex = lines.findIndex((l, i) => i > 0 && l.event === 'APP_LAUNCH');
  const killed = !stopped && relaunchIndex >= 0;
  if (stopped) lines = lines.slice(0, stopIndex + 1);
  else if (killed) lines = lines.slice(0, relaunchIndex);

  const start = lines[0].t;
  const end = lines[lines.length - 1].t;
  const times = (event) => lines.filter((l) => l.event === event).map((l) => l.t);
  const count = (event) => lines.filter((l) => l.event === event).length;

  const fixes = lines.filter((l) => l.event === 'LOC');
  const backgroundFixes = fixes.filter((l) => field(l.details, 'app') === 'background').length;

  const spoken = lines.filter((l) => l.event === 'SPEECH_STARTED');
  const spokenInBackground = spoken.filter((l) => field(l.details, 'app') === 'background').length;
  const routes = new Set();
  for (const l of lines) {
    if (l.event === 'SPEECH_STARTED' || l.event === 'ROUTE_CHANGE' || l.event === 'SESSION_START') {
      const route = field(l.details, 'route');
      if (route) routes.add(route);
    }
  }

  const latencies = lines
    .filter((l) => l.event === 'FETCH_OK')
    .map((l) => Number(field(l.details, 'ms')))
    .filter((ms) => Number.isFinite(ms))
    .sort((a, b) => a - b);

  const jsTimers = lines.filter((l) => l.event === 'JS_TIMER');
  const lastJs = jsTimers[jsTimers.length - 1];
  const jsHidden = jsTimers.filter((l) => field(l.details, 'pageHidden') === 'true').length;

  let backgroundMs = 0;
  let state = field(lines[0].details, 'app') ?? 'active';
  let since = start;
  for (const l of lines) {
    if (l.event !== 'APP_STATE') continue;
    if (state === 'background') backgroundMs += l.t - since;
    if (l.details === 'background' || l.details === 'active' || l.details === 'inactive') {
      state = l.details;
      since = l.t;
    }
  }
  if (state === 'background') backgroundMs += end - since;

  return {
    start,
    end,
    stopped,
    killed,
    durationSeconds: (end - start) / 1000,
    backgroundSeconds: backgroundMs / 1000,
    fixes: fixes.length,
    backgroundFixes,
    longestFixGap: longestGap(times('LOC'), start, end),
    speechRequested: count('SPEECH_REQUEST'),
    speechStarted: spoken.length,
    spokenInBackground,
    speechFinished: count('SPEECH_FINISHED'),
    speechFailures: count('SPEECH_FAILED'),
    speechPauses: count('SPEECH_PAUSED'),
    longestSpeechGap: longestGap(times('SPEECH_STARTED'), start, end),
    audioErrors: count('AUDIO_ERROR'),
    audioInterruptions: lines.filter(
      (l) => l.event === 'AUDIO_INTERRUPTION' && l.details.startsWith('began'),
    ).length,
    routes: [...routes],
    fetchOk: latencies.length,
    fetchFailures: count('FETCH_FAILED'),
    fetchMedianMs: latencies.length ? latencies[Math.floor(latencies.length / 2)] : null,
    fetchMaxMs: latencies.length ? latencies[latencies.length - 1] : null,
    longestFetchGap: longestGap(times('FETCH_OK'), start, end),
    jsTimerFires: jsTimers.length,
    jsTimerFiresWhileHidden: jsHidden,
    longestJsTimerGap: longestGap(times('JS_TIMER'), start, end),
    geoPluginFixesSeenByJs: lastJs ? Number(field(lastJs.details, 'geoPluginFixesSeenByJs')) : 0,
    nativeFixEventsSeenByJs: lastJs ? Number(field(lastJs.details, 'nativeFixEventsSeenByJs')) : 0,
    locationErrors: count('LOC_ERROR') + count('LOC_PAUSED'),
    errors: count('ERROR'),
  };
}

export function formatDuration(seconds) {
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m === 0) return `${rest} s`;
  return `${m} min ${String(rest).padStart(2, '0')} s`;
}

export function formatClock(t) {
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Plain-language rows for the screen. `bad` marks a row that needs attention.
 * @returns {{ label: string, value: string, bad: boolean }[]}
 */
export function summaryRows(s) {
  if (!s) return [];
  const gap = (g) => `${formatDuration(g.seconds)} (from ${formatClock(g.at)})`;
  const ending = s.stopped
    ? 'stopped normally'
    : s.killed
      ? 'APP WAS KILLED OR CRASHED'
      : 'no Stop recorded (still running, or iOS ended the app)';
  return [
    { label: 'Session', value: `${formatDuration(s.durationSeconds)}, ${ending}`, bad: s.killed },
    {
      label: 'In background or locked',
      value: formatDuration(s.backgroundSeconds),
      bad: false,
    },
    {
      label: 'Location fixes',
      value: `${s.fixes} (${s.backgroundFixes} in background)`,
      bad: s.fixes === 0,
    },
    { label: 'Longest gap between fixes', value: gap(s.longestFixGap), bad: s.longestFixGap.seconds > 10 },
    {
      label: 'Lines spoken',
      value: `${s.speechStarted} of ${s.speechRequested} (${s.spokenInBackground} in background)`,
      bad: s.speechStarted < s.speechRequested,
    },
    {
      label: 'Longest gap between spoken lines',
      value: gap(s.longestSpeechGap),
      bad: s.longestSpeechGap.seconds > 45,
    },
    {
      label: 'Speech failures',
      value: `${s.speechFailures} failed, ${s.speechPauses} paused by iOS, ${s.audioErrors} audio errors`,
      bad: s.speechFailures + s.speechPauses + s.audioErrors > 0,
    },
    { label: 'Audio interruptions (calls etc.)', value: String(s.audioInterruptions), bad: false },
    { label: 'Audio outputs seen', value: s.routes.join(', ') || 'none', bad: false },
    {
      label: 'Fetches',
      value:
        `${s.fetchOk} ok, ${s.fetchFailures} failed` +
        (s.fetchMedianMs === null ? '' : `, median ${s.fetchMedianMs} ms, slowest ${s.fetchMaxMs} ms`),
      bad: s.fetchFailures > 0,
    },
    {
      label: 'Longest gap between good fetches',
      value: gap(s.longestFetchGap),
      bad: s.longestFetchGap.seconds > 90,
    },
    {
      label: 'Web page timer (10 s)',
      value: `${s.jsTimerFires} fires (${s.jsTimerFiresWhileHidden} while hidden), longest gap ${formatDuration(s.longestJsTimerGap.seconds)}`,
      bad: s.longestJsTimerGap.seconds > 30,
    },
    {
      label: 'Fixes that reached the web page',
      value: `${s.nativeFixEventsSeenByJs} from probe, ${s.geoPluginFixesSeenByJs} from geolocation plugin`,
      bad: false,
    },
    {
      label: 'Location errors / other errors',
      value: `${s.locationErrors} / ${s.errors}`,
      bad: s.locationErrors + s.errors > 0,
    },
  ];
}
