# RouteIQ Probe

A throwaway iPhone test app. It does not navigate. It answers one question on a real drive:

> If RouteIQ were an installed app instead of a web page, would iOS let it keep getting GPS, keep
> making network requests and keep speaking while the phone is locked or another app is in front, and
> would the voice come out of the car?

Nothing here touches the main web app. This folder has its own `package.json`.

## What it does

One screen, three buttons: **Start**, **Stop**, **Export log**. After Start it:

| Every | Action | Runs in |
| --- | --- | --- |
| location fix (about 1 per second) | counts it, logs accuracy and speed | native Swift |
| 30 s | speaks "Probe 7. 12:42." ("Probe 7, standing still. 12:42." when speed is zero) | native Swift |
| 60 s | HTTPS GET to `https://captive.apple.com/hotspot-detect.html`, logs success and latency | native Swift |
| 10 s | a plain web-page timer reports to the log | JavaScript in the WebView |

It also logs app state changes (active / inactive / background), phone locked / unlocked, audio output
changes (speaker, Bluetooth, CarPlay), audio interruptions such as a phone call, permission changes
and errors. Every line has a wall-clock timestamp and is written to disk immediately, so the log
survives the app being killed. **Gaps in the log show exactly what iOS suspended.**

Privacy: coordinates are never written to the log, never stored and never sent. The web request
carries no data. The log holds counts, accuracy in metres, speed, times and audio output types.

### What it proves, and what it cannot

| Question | Where to look |
| --- | --- |
| Does GPS continue while locked? | "Longest gap between fixes", "in background" count |
| Does speech continue while locked? | "Lines spoken ... in background", "Speech failures", and your ears |
| Does speech reach the car? | "Audio outputs seen" shows `carplay` or `bluetooth-...`, and your ears |
| Do network requests continue? | "Fetches", "Longest gap between good fetches" |
| Does a web page's own JavaScript stay alive? | "Web page timer", "Fixes that reached the web page" |

The log can say a line *started and finished playing*. It cannot say you *heard* it. A line can play
into a muted or wrong output. That is why the drive script asks you to listen.

## Architecture

- **Capacitor 8 shell** (`capacitor.config.json`, `www/`, `src/`): the same wrapper the real app
  would use around the existing web code.
- **Local Swift plugin** (`probe-native/`): owns `CLLocationManager`, `AVSpeechSynthesizer`,
  `URLSession` and the log file. The web page is never in the path of anything being measured. Speech
  and fetch are triggered from the location callback, with a native 2 s timer as a backup that only
  acts when a line is more than 3 s overdue (the log says `trigger=location` or `trigger=timer`).
- **Audio session**: `.playback`, mode `.voicePrompt`, options `duckOthers` +
  `interruptSpokenAudioAndMixWithOthers`. Music is lowered while a line plays, podcasts and other
  spoken audio pause briefly, and the session is released after each line.
- **Two deliberately web-side paths**, logged next to the native ones:
  1. a 10 s `setInterval` (`JS_TIMER` lines);
  2. `@capacitor-community/background-geolocation` delivering fixes to JavaScript (reported as
     `geoPluginFixesSeenByJs` inside each `JS_TIMER` line).
  If these keep up with the native lines while locked, most of the real app can stay as web code. If
  they stall, the timing-critical parts must be native.

### Why the Xcode project is not in git

`ios/` is generated on the build machine by `npm run ios:generate` (`npx cap add ios`, then
`scripts/info-plist.mjs` adds the background modes and location texts). It is fully determined by
`package-lock.json`, `capacitor.config.json` and that script, and Capacitor 8 uses Swift Package
Manager, so no project-file editing is needed: the Swift plugin is picked up as a local package.
Committing ~40 generated files would add nothing and would drift. The build fails early if the
generated project is missing a plugin or an Info.plist key.

### Files

| Path | Purpose |
| --- | --- |
| `probe-native/ios/Sources/ProbeNativePlugin/ProbeEngine.swift` | location, speech, fetch, observers |
| `probe-native/ios/Sources/ProbeNativePlugin/ProbeLog.swift` | append-only log file |
| `probe-native/ios/Sources/ProbeNativePlugin/ProbeNativePlugin.swift` | bridge to the web page, share sheet |
| `src/main.js`, `www/index.html` | the screen, the web timer, the web geolocation watcher |
| `src/summary.js` | turns the log into the summary (tested in `tests/`) |
| `scripts/generate-ios.mjs`, `scripts/info-plist.mjs` | create and patch the Xcode project |
| `../../.github/workflows/probe-ios.yml` | cloud build |

Local checks on Windows (no Mac needed): `npm.cmd ci`, `npm.cmd test`, `npm.cmd run build`,
`npm.cmd run ios:generate`. Compiling needs the cloud build.

## Getting the .ipa

The build runs on GitHub Actions (macOS runner) and produces an **unsigned** `.ipa`. Unsigned means it
cannot be installed as-is; the sideloading tool signs it with your Apple ID.

1. Open the repository on GitHub, **Actions** tab, workflow **Probe iOS (unsigned ipa)**.
2. Open the newest run with a green tick.
3. At the bottom, under **Artifacts**, download **RouteIQ-Probe-unsigned** (a `.zip`).
4. Unzip it. Inside is `RouteIQ-Probe-unsigned.ipa`.

From a terminal instead: `gh run list --workflow probe-ios.yml`, then
`gh run download <run-id> -n RouteIQ-Probe-unsigned`.

Artifacts are deleted after 30 days. To rebuild: push any change under `native/probe/` to the
`native-probe` branch. The **Run workflow** button only appears once the workflow file is on the
default branch (a GitHub rule). A build takes about one minute. macOS minutes on a private repository
are billed at 10x and rounded up per job, so each build counts as roughly 10 minutes of the monthly
allowance.

## Installing from Windows with a free Apple ID

All three tools do the same thing: sign in to Apple as you, ask Apple for a free 7-day development
certificate, sign the `.ipa` and install it. The same Apple limits apply to all of them: the app
**stops opening after 7 days** unless re-signed ("refreshed"), at most **3 sideloaded apps** on a
device, about **10 new app IDs per 7 days**. The tool rewrites the bundle id (`dev.routeiq.probe` is a
placeholder).

In every case **you type an Apple ID and password into a third-party tool**. Each says the
credentials go only to Apple; that cannot be verified from here. A common precaution is a separate
Apple ID made only for this, not the one holding your purchases, photos and payment methods. The
signing Apple ID does not need to be the one signed in on the phone.

| | Sideloadly | AltStore Classic | SideStore |
| --- | --- | --- | --- |
| What it is | Windows program that signs and installs an `.ipa` | Windows helper (AltServer) plus an AltStore app on the phone | Store app on the phone; a PC is needed only for first setup |
| Source | Closed source, free | Open source | Open source (fork of AltStore) |
| Needs on the PC | iTunes and iCloud from Apple's website, not the Microsoft Store versions | Same iTunes and iCloud requirement; AltServer run as administrator | iTunes (for the USB driver) and the `iloader` program for first install |
| Needs on the phone | Nothing extra | AltStore app (uses 1 of the 3 app slots) | SideStore app (uses 1 of the 3 slots) plus the LocalDevVPN app from the App Store, switched on whenever installing or refreshing |
| Installing this `.ipa` | Drag the file in, enter Apple ID, press Start, phone on USB | Shift-click the AltServer tray icon, "Sideload .ipa", or open the file from the AltStore app | Open the file from the SideStore app ("+" in My Apps) |
| Keeping it past 7 days | PC app re-signs automatically when the phone is reachable (USB or same Wi-Fi) | AltStore app refreshes when AltServer is running on the same Wi-Fi | Refreshes on the phone itself, no PC, with the VPN on |
| iOS versions claimed by its own docs | iOS 7 to 27+ | iOS 16+ steps documented; no upper limit stated on the pages read | iOS 15.0+ ; steps listed for 18.0+ |
| Fewest moving parts for a one-week test | Yes | Middle | Most setup, least upkeep |

Could not be confirmed from here: that each tool works today with the exact iOS version on your phone
(none was run); whether Sideloadly's claim of iOS 27 support holds on the current point release;
AltStore Classic's highest supported iOS version (its pages do not state one); how each tool actually
handles the password. Check each tool's own site on the day you install. Download them only from
their own sites: sideloadly.io, altstore.io, sidestore.io.

For a single one-week test, any of the three is enough. This repository does not install or
configure any of them.

## First run on the phone

1. **Trust the developer profile.** Settings > General > VPN & Device Management > under "Developer
   App" tap your Apple ID > Trust. Until then the app refuses to open.
2. **Developer Mode** (iOS 16 and later). Settings > Privacy & Security > Developer Mode > On. The
   phone restarts and asks again to confirm. If the switch is not listed, try opening the app once
   first.
3. Open **RouteIQ Probe**. Press **Start**.
4. Location question: choose **Allow While Using App**. A second question follows (immediately, or
   later while the app is in the background): choose **Change to Always Allow**. If it never appears:
   Settings > Privacy & Security > Location Services > RouteIQ Probe > **Always**, and leave
   **Precise Location** on.
5. Within about 5 seconds you should hear "Probe 1 ...". If you do not: check the ring/silent switch
   is not the cause (it should not be, the app uses the playback category), turn the volume up, press
   Stop and Start.
6. Press **Stop**. Do this whole section at home, not in the car, so that on the drive Start is the
   only tap.

While running in the background iOS shows a blue location indicator at the top of the screen. That is
expected.

## Drive test script (about 15 minutes)

Before leaving: phone charged, volume up, a music app ready, CarPlay working as usual, and someone who
can call you at a set time (or use a second phone when parked). **Do not touch the phone while
moving.** Steps that need a tap are done parked or by a passenger. Note the clock time of each step;
you will match them to the log.

| # | Minute | Do this | What you are testing | Listen for |
| --- | --- | --- | --- | --- |
| 1 | 0 | Parked, CarPlay **not** connected. Open Probe, press **Start**, wait for "Probe 1". | Baseline in foreground | A line every 30 s from the phone speaker |
| 2 | 1 | Lock the phone, put it in your pocket. Stay parked for 1 minute, then drive. | Locked, speaker, standing still then moving | Lines keep coming; wording changes from "standing still" once moving |
| 3 | 4 | Stop somewhere safe. Connect CarPlay (cable or wireless). Leave the phone locked. | Audio moves to the car | Lines come from the **car speakers** |
| 4 | 5 | On the car screen open Apple Maps or Google Maps and start a route. Drive. | Another navigation app in front, both talking | Probe lines still play; note whether they cut off or overlap the other app's directions |
| 5 | 8 | Start music from the car screen. | Talking over music | Music gets quieter during each line and returns to full volume after |
| 6 | 10 | Have someone call you. Answer on the car, talk for 40 s, hang up. | Interruption and recovery | Silence during the call is fine. Lines must **resume by themselves** within 30 s of hanging up |
| 7 | 12 | Parked: unlock the phone, open two or three other apps (Messages, a browser), leave Probe in the background for 2 minutes, lock again. | Other app in front on the phone | Lines continue throughout |
| 8 | 14 | Parked: open Probe, press **Stop**. Read the summary. Press **Export log** and send the file to yourself (AirDrop, Mail, Save to Files). | | |

Optional, if you have time: repeat steps 2 to 5 with Low Power Mode on, and once with the phone on
the car's Bluetooth but without CarPlay.

### Reading the summary

Red rows need a look. A healthy run looks like this:

| Row | Healthy | Meaning if not |
| --- | --- | --- |
| Session | about 14 min, "stopped normally" | "APP WAS KILLED OR CRASHED": iOS terminated the app; the time of the last log line shows when |
| In background or locked | most of the session | If near zero the test was not really run locked |
| Longest gap between fixes | 1 to 3 s | More than 10 s: iOS paused location. Check what happened at that time |
| Lines spoken | equal to requested, most "in background" | Fewer: speech is being blocked. See the next row |
| Longest gap between spoken lines | about 30 s (up to about 70 s around the phone call) | Minutes long: speech stopped and did not recover |
| Speech failures | 0 failed, 0 paused, 0 audio errors (a few around the call are expected) | "paused by iOS" is the reported pause-on-lock problem; "audio errors" means the audio session could not start in the background |
| Audio outputs seen | `speaker` then `carplay` (or `bluetooth-a2dp` / `bluetooth-hfp`) | Only `speaker` while in the car: audio never moved to the car |
| Fetches | all ok, latency a few hundred ms | Failures while locked: background networking is restricted |
| Web page timer | about 6 fires per minute, longest gap near 10 s | Long gaps: the WebView's JavaScript was suspended, so the real app cannot rely on web timers |
| Fixes that reached the web page | both numbers close to "Location fixes" | Much lower: location events do not reach web code in the background |

### What each outcome means for the real app

| Result | Conclusion |
| --- | --- |
| Fixes, speech and fetch all continue locked, audio from the car | The installed-app route works with a free Apple ID. Build the real app this way |
| Web timer and web fixes also keep up | Wrap the existing web code nearly as-is; only speech needs native code |
| Native lines fine, web timer or web fixes stall | Keep the shell, but move route-following, rerouting triggers and announcements into native code |
| Speech "paused by iOS" or fails when locked, GPS fine | `AVSpeechSynthesizer` is the problem. Next test: play pre-rendered audio clips with `AVAudioPlayer`, or keep the audio session active between lines |
| Speech plays per the log but nothing is heard in the car | A routing problem. Next test: other audio session modes, and the CarPlay audio settings in the car |
| Speech resumes after a call only when the app is reopened | Needs explicit handling of audio interruptions; fixable in native code |
| Location stops after some minutes locked | Check the permission was "Always" and Precise; if it was, a free-account build cannot do this and the plan needs rethinking |
| App killed mid-drive | Look at the last lines of the log (memory warning, time). One occurrence is not conclusive; repeat |

Send the exported log along with the clock times you noted. The log has no coordinates in it.

## The log format

Plain text, one event per line, tab-separated: time with UTC offset, event name, details.

```
2026-01-01T12:42:07.123-05:00	LOC	n=412 acc=5 speed=13.4 age=0.1 app=background
2026-01-01T12:42:08.004-05:00	SPEECH_REQUEST	n=14 trigger=location app=background route=carplay text="Probe 14. 12:42."
2026-01-01T12:42:08.210-05:00	SPEECH_STARTED	n=14 app=background route=carplay
2026-01-01T12:42:10.502-05:00	SPEECH_FINISHED	n=14 app=background route=carplay ms=2291
```

Events: `APP_LAUNCH`, `SESSION_START`, `SESSION_STOP`, `AUTH`, `LOC`, `LOC_ERROR`, `LOC_PAUSED`,
`LOC_RESUMED`, `SPEECH_REQUEST`, `SPEECH_STARTED`, `SPEECH_FINISHED`, `SPEECH_FAILED`,
`SPEECH_PAUSED`, `SPEECH_CONTINUED`, `SPEECH_CANCELLED`, `AUDIO_ERROR`, `AUDIO_INTERRUPTION`,
`ROUTE_CHANGE`, `FETCH_REQUEST`, `FETCH_OK`, `FETCH_FAILED`, `APP_STATE`, `DEVICE`, `LOW_POWER_MODE`,
`MEMORY_WARNING`, `JS_TIMER`, `JS_NOTE`, `EXPORT`, `ERROR`.

The file is also visible in the Files app under On My iPhone > RouteIQ Probe
(`routeiq-probe-log.txt`), in case the share sheet fails.
