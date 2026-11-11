import test from 'node:test';
import assert from 'node:assert/strict';
import { field, parseLog, summarize, summaryRows } from '../src/summary.js';

// Builds a log the way the native side writes it: time TAB event TAB details.
function log(rows) {
  const base = Date.parse('2026-01-01T12:00:00.000-05:00');
  return rows
    .map(([seconds, event, details = '']) => {
      const d = new Date(base + seconds * 1000);
      const stamp = d.toISOString().replace('Z', '+00:00');
      return [stamp, event, details].filter((part) => part !== '').join('\t');
    })
    .join('\n');
}

test('parseLog skips malformed lines and keeps details with tabs', () => {
  const lines = parseLog('garbage\n2026-01-01T12:00:00.000-05:00\tLOC\tn=1 acc=5\textra\n\n');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].event, 'LOC');
  assert.equal(lines[0].details, 'n=1 acc=5\textra');
});

test('field reads key=value pairs, including quoted text', () => {
  assert.equal(field('n=3 app=background route=carplay', 'app'), 'background');
  assert.equal(field('n=3 text="Probe 3. 12:42."', 'text'), '"Probe 3. 12:42."');
  assert.equal(field('n=3', 'missing'), undefined);
});

test('summarize returns null when nothing was recorded', () => {
  assert.equal(summarize(''), null);
  assert.equal(summarize(log([[0, 'APP_LAUNCH', 'probe=0.1.0']])), null);
});

test('a healthy session has small gaps and no failures', () => {
  const rows = [[0, 'SESSION_START', 'app=active route=speaker']];
  for (let s = 1; s <= 120; s++) rows.push([s, 'LOC', `n=${s} acc=5 speed=12.0 app=background`]);
  for (const s of [5, 35, 65, 95]) {
    rows.push([s, 'SPEECH_REQUEST', 'n=1 app=background route=carplay']);
    rows.push([s + 0.2, 'SPEECH_STARTED', 'n=1 app=background route=carplay']);
    rows.push([s + 2, 'SPEECH_FINISHED', 'n=1 app=background route=carplay ms=1800']);
  }
  rows.push([10.3, 'FETCH_OK', 'n=1 ms=300 status=200']);
  rows.push([70.1, 'FETCH_OK', 'n=2 ms=100 status=200']);
  rows.push([3, 'APP_STATE', 'inactive'], [4, 'APP_STATE', 'background']);
  rows.push([110, 'JS_TIMER', 'seq=1 nativeFixEventsSeenByJs=110 geoPluginFixesSeenByJs=108 pageHidden=true']);
  rows.push([121, 'SESSION_STOP', 'fixes=120']);
  rows.sort((a, b) => a[0] - b[0]);

  const s = summarize(log(rows));
  assert.equal(s.stopped, true);
  assert.equal(s.killed, false);
  assert.equal(s.durationSeconds, 121);
  assert.equal(s.backgroundSeconds, 117);
  assert.equal(s.fixes, 120);
  assert.equal(s.backgroundFixes, 120);
  assert.equal(s.longestFixGap.seconds, 1);
  assert.equal(s.speechStarted, 4);
  assert.equal(s.spokenInBackground, 4);
  assert.equal(s.speechFailures, 0);
  assert.equal(Math.round(s.longestSpeechGap.seconds), 30);
  assert.deepEqual(s.routes.sort(), ['carplay', 'speaker']);
  assert.equal(s.fetchOk, 2);
  assert.equal(s.fetchMaxMs, 300);
  assert.equal(s.geoPluginFixesSeenByJs, 108);
  assert.equal(s.jsTimerFiresWhileHidden, 1);
  // The page timer fired only once in two minutes: that row must be flagged.
  const timerRow = summaryRows(s).find((r) => r.label.startsWith('Web page timer'));
  assert.equal(timerRow.bad, true);
  assert.equal(summaryRows(s).find((r) => r.label === 'Speech failures').bad, false);
});

test('speech that stops for good shows up as a long gap, not a clean result', () => {
  const rows = [[0, 'SESSION_START', 'app=active route=speaker']];
  rows.push([5, 'SPEECH_REQUEST', 'n=1'], [5.1, 'SPEECH_STARTED', 'n=1 app=active route=speaker']);
  rows.push([35, 'SPEECH_REQUEST', 'n=2'], [41, 'SPEECH_FAILED', 'n=2 reason=did not start within 6 s']);
  rows.push([65, 'SPEECH_REQUEST', 'n=3'], [65.5, 'SPEECH_PAUSED', 'n=3']);
  rows.push([300, 'LOC', 'n=1 acc=5 speed=na app=background']);
  const s = summarize(log(rows));
  assert.equal(s.stopped, false);
  assert.equal(s.speechRequested, 3);
  assert.equal(s.speechStarted, 1);
  assert.equal(s.speechFailures, 1);
  assert.equal(s.speechPauses, 1);
  assert.ok(s.longestSpeechGap.seconds > 290);
  assert.equal(s.longestFixGap.seconds, 300);
  const rowsOut = summaryRows(s);
  assert.equal(rowsOut.find((r) => r.label === 'Lines spoken').bad, true);
  assert.equal(rowsOut.find((r) => r.label === 'Longest gap between spoken lines').bad, true);
  assert.equal(rowsOut.find((r) => r.label === 'Longest gap between fixes').bad, true);
});

test('only the last session counts, and a relaunch without Stop means the app was killed', () => {
  const text = log([
    [0, 'SESSION_START', 'app=active'],
    [1, 'FETCH_FAILED', 'n=1 ms=15000'],
    [2, 'SESSION_STOP'],
    [100, 'SESSION_START', 'app=active'],
    [101, 'LOC', 'n=1 acc=5 speed=0.0 app=active'],
    [160, 'LOC', 'n=2 acc=5 speed=0.0 app=background'],
    [500, 'APP_LAUNCH', 'previousSessionEndedWithoutStop=true'],
    [501, 'APP_STATE', 'active'],
  ]);
  const s = summarize(text);
  assert.equal(s.fetchFailures, 0);
  assert.equal(s.killed, true);
  assert.equal(s.fixes, 2);
  assert.equal(s.durationSeconds, 60);
  assert.match(summaryRows(s)[0].value, /KILLED/);
});
