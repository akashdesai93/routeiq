# The phone lab: tests on the real iPhone, with nobody touching it

The PC runs a scenario on the iPhone on its USB cable: it starts RouteIQ, starts a drive, sends
the app to the background (or puts the phone to sleep), replays a drive with a wrong turn as the
phone's position, brings the app back, and checks what the app did meanwhile. It writes a report
folder with screenshots and the app's own diagnostics.

```powershell
node scripts/phone/lab/run.mjs --scenario locked-wrong-turn
```

> **While a drive scenario runs, the whole phone reports the simulated position**: Find My, Maps,
> Weather and every other app see the phone in Charlotte. A run takes 4 to 12 minutes. The runner
> clears it at the end, when it fails and on Ctrl+C, and the summary says from when to when and
> whether the clear worked. If the PC lost power mid-run: `scripts\phone\sim-drive.ps1 -ClearOnly`,
> or restart the phone.
>
> **The phone speaks during a drive scenario**, at its media volume: "RouteIQ started", turns, "New
> route". Turn the volume down before a night run if that matters.

## What the owner has to do

Once: nothing more than what `docs/phone-install.md` and `docs/phone-sim-location.md` already
needed (the phone trusts this PC, Developer Mode is on, pymobiledevice3 is installed, Sideloadly
is open with the phone and the Apple ID chosen).

Each time, before leaving the phone alone:

1. Leave it **plugged in and unlocked, with RouteIQ or the home screen showing**. A phone with a
   passcode that has locked cannot be opened from the PC, and every scenario starts with the app
   in front. Settings → Display & Brightness → Auto-Lock → **Never** keeps it open while it is on
   the cable. **The owner's phone has a passcode.** Once it is locked, the lab can install builds
   and nothing else until the owner unlocks it.
2. Leave **Sideloadly open** on the PC if a build is to be installed.

Optional, for a person who wants to poke at the running app from the PC: Settings → Apps → Safari
→ Advanced → **Web Inspector** on. In lab mode the app's web view can then be inspected, and
`window.__routeiqLab` is there to call. The scenarios do not need it.

## How it works

| Piece | Where | What it does |
| --- | --- | --- |
| Lab mode in the app | `native/shell/shell-native/ios/Sources/RouteIQNativePlugin/RouteIQLab.swift`, `src/lab/lab.ts` | Off unless the app is started with the launch argument `-routeiqLab <scenario>`. Only a computer the phone trusts can pass a launch argument; opened by hand, the app never has it. |
| The hook | `src/lab/lab.ts` | A robot user: it presses the app's own buttons and reads the app's own screen. Every second it notes what the screen shows as a fixed word (`driving`, `off-route`, `banner new-route-after-off-route` …), and every 3 seconds it writes a report. |
| The report file | `tmp/routeiq-lab-report.txt` in the app's own folder | The hook's notes plus the drive diagnostics (`src/device/native/diagnostics.ts`). The PC pulls this one file over USB. Counts, times of day and fixed words only: no position, no address, no road name, no token. |
| The runner | `scripts/phone/lab/run.mjs`, `phone.mjs`, `device.py` | Drives the phone with [pymobiledevice3](https://github.com/doronz88/pymobiledevice3): starts apps, takes screenshots, sets the phone's position, samples CPU and memory, reads the screen as text. |
| The checks | `scripts/phone/lab/assertions.mjs` | Pure functions from the report text to pass or fail. `tests/phoneLab.test.ts` shows each one failing on the fault it is there for. |

Things learned on the phone that the design rests on:

- **The simulated position lasts only as long as the connection that set it.** Separate
  pymobiledevice3 commands each open their own tunnel, and the position fell back to the real GPS
  in between. So `device.py` is one long-lived process with one connection, and the runner sends
  it the position once a second.
- **A lab drive starts only at the simulated position.** The scenario's name carries the
  simulated start (`drive-at-<lng>-<lat>`); the hook asks the phone where it is and presses
  Start drive only within 250 m of that point. On the phone's real position it does not start,
  and it writes "not at the simulated start" without saying where the phone is.
- **Nothing can tap the screen.** The accessibility service reads every element of the screen
  (that is how a build without the lab is checked for routes), but its "press" does nothing in a
  web view. Hence the hook inside the app.
- **Background.** Starting Calculator puts RouteIQ in the background; starting RouteIQ again
  (without ending it) brings it back.
- **Sleep ends the PC's connection, and with it the simulated position.** `diagnostics sleep`
  turns the screen off as the side button does, and the developer connection drops at that
  moment. So there are two ways to move the car:
  - *over USB* (the default): the phone's own location services report the replayed position, so
    this is the test of iOS delivering GPS to an app that is not in front. The screen stays on,
    with another app in front.
  - *in the app* (`--lock`, or `--in-app` with the screen on): the app's own test drive ("Test
    drive (simulated GPS)", wrong turn after a minute) moves a made-up car on a native timer. It
    needs no connection, so the phone can really sleep. The phone's position is not used or
    changed. This is the test of the web code, the route requests and the voice going on with
    the screen off; its fixes come from the app's timer, not from the GPS.
  After the time away the runner connects again and starts RouteIQ. **That does not turn the
  screen back on.** On 2026-11-11 the app started and its screen could be read as text, but
  every screenshot after a `--lock` run was black until the screen was woken by something else.
  So `--lock` is the last thing to run in a session, and the runner refuses it without
  `--owner-unlocks-after`.
- **Do not press the side button from the PC.** With the developer disk image mounted
  (`pymobiledevice3 mounter auto-mount`, what Xcode does when a phone is plugged in; it lasts
  until the phone restarts), `developer core-device hid button lock` presses it. That wakes the
  screen, on the lock screen, and the phone then locks with its passcode: apps can no longer be
  started from the PC. This is how the first night's session ended. The same service can send
  touches (`universal-hid-service tap`); it has not been used, and a tap on an unlocked phone
  would be the way to press Start drive on a build without the lab.

### The hook, for a person at a Web Inspector console

`window.__routeiqLab` (lab mode only): `press(name)`, `setPlace('origin' | 'destination', name)`,
`resetToTestPoints()`, `startDrive()`, `endDrive()`, `read()` (screen, routes, turn card, arrival
line, status, banner, warnings, as shown), `startTestDrive()` (switches on the in-app test
drive), `testDriveOn()`, `diagnostics()`, `report()`. What `read()` returns can hold road and
place names; it is for the person at the console and is never written to the report file.

## Scenarios

| `--scenario` | What it does | Time |
| --- | --- | --- |
| `starts-and-plans` | Starts the app, waits for the plan screen, takes a screenshot. No simulated position. | 30 s |
| `locked-wrong-turn` | Stands 4.4 km into the Uptown → SouthPark drive, starts the app in lab mode (it starts the drive), sends it to the background, replays the `wrong-turn` track for 170 s (the turn comes about 70 s in), waits 15 s, brings the app back. | 5 min |
| `background-soak` | The same with the track that stays on the route, from its start, for `--minutes` (default 10). One CPU, memory and battery sample a minute. | 12 min |
| `drive-screen` | Starts the in-app test drive, leaves the app in front and takes screenshots 3, 9, 18 and 30 s into the drive. With `--fix <name>` the app tries one thing on the page 12 s in (`resize`, `reflow`, `layer`, `nomap`, `scroll`: `src/lab/probe.ts`), and the report's `layout` line says how the page is laid out. No simulated position. | 45 s |

Options: `--lock --owner-unlocks-after` (put the phone to sleep while away; the car is then the
in-app test drive; the screen stays off afterwards, so nothing visual can be checked after it),
`--in-app` (the in-app test drive with the screen on), `--no-gps` (over USB only: do not replay
the drive, the phone stands still, and the off-route check must then fail), `--away-sec`,
`--minutes`, `--from-m`, `--speed`, `--push-web` and `--web` (below), `--out`.

```powershell
node scripts/phone/lab/run.mjs --scenario locked-wrong-turn            # background, GPS over USB
node scripts/phone/lab/run.mjs --scenario drive-screen                 # is the driving screen drawn? 45 s
node scripts/phone/lab/run.mjs --scenario locked-wrong-turn --lock --owner-unlocks-after   # phone asleep; LAST run of a session
node scripts/phone/lab/run.mjs --scenario locked-wrong-turn --no-gps   # must FAIL the off-route check
node scripts/phone/lab/run.mjs --scenario background-soak --minutes 10
```

Exit code: 0 all checks passed, 1 a check failed, 2 a check could not be made (the summary says
which and why; that is never counted as a pass).

### What each check proves

`locked-wrong-turn`:

| Check | Passes when | What it proves |
| --- | --- | --- |
| Position fixes kept arriving while the app was not in front | more than 30 fixes were counted while the app was inactive or in the background | iOS kept delivering GPS to the app when it was not on screen. |
| No wait of 5 s or more between ticks | more than 30 ticks while away, and no "no tick for N s" event from the moment the app left the front (if the event log overflowed: the longest wait of the whole drive is under 5 s) | The web code that runs the drive was not suspended. A suspended web view shows up here first. |
| A route request went out while not in front and was answered | a request logged as sent while away has an HTTP 2xx answer | Networking through `URLSession` works while the app is away, which a web view's own `fetch` may not. |
| Off the route, then a new route | the screen showed "New route from here" (shown only for a route taken because the car left the route), a route request (not a side-street probe) went out in the 15 s before it and was answered, and at the end the screen shows a drive going on | The wrong turn was noticed and recovered from, end to end, while away. |
| Every spoken line that started also finished | at least one line started, as many finished, none cut off | The voice was not cut off by the app being away. |

Two more, in both drive scenarios:

| Check | Passes when | What it proves |
| --- | --- | --- |
| The screen is drawn 8 s after the drive started, and after the app came back | under 97 % of the screenshot below the status bar is one flat colour | The driving screen is on the glass, not only in the page. Added after #136: the new driving screen was all black on the phone while the page had the turn card and the drive ran and spoke. |
| The app stayed in the background until the lab brought it back | one stretch in the background of at least 90 % of the time meant | The other checks cover the time they claim. In three runs the app logged "active" again after 97 to 243 s without the lab asking; why is not known yet. |

Every run's summary also has a **Numbers** table for comparing builds: seconds in the background,
fixes and ticks while not active, the longest stop while away (limit 5 s; 39 s on the first
`--lock` run), the longest wait between fixes, route requests sent while away, requests sent,
answered and failed, spoken lines, and new routes after leaving the route.

`background-soak`: fixes and ticks at 30 a minute or more for the whole time away, the same tick
and request checks, no failed route request, and the speech check.

`drive-screen`: the screen is drawn at each of the four moments.

`starts-and-plans`: at least one route is listed and Start drive is there.

### The report folder

`phone-lab/report-<date>-<time>/` (git-ignored, stays on this PC):

- `summary.md`: result, each check with what was seen, the steps with their times, CPU, memory and
  battery samples, and the time window of the simulated position.
- `drive-started.png`, `back-in-front.png`, `plan.png`: the phone's screen. They show a map; they
  are not for publishing.
- `diagnostics.txt`, `lab-report.txt`, `lab-report-away.txt`: what the app wrote.
- `screen-text.txt`: the screen as a screen reader reads it, after coming back.
- `syslog.txt`: the app's lines of the phone's system log, with identifiers, numbers that look
  like coordinates and tokens taken out.

## Getting a build onto the phone

Two ways, and the first needs no signing at all.

**1. Web changes: push them over USB.** Most changes are to the web app. `--push-web` builds the
shell's web app (`native/shell`, no token in it) and copies it into the installed app's temporary
folder; in lab mode with `-routeiqLabWeb` the app loads that copy instead of the one built in.
Same origin, so the token and everything stored stay as they are.

```powershell
node scripts/phone/lab/run.mjs --scenario locked-wrong-turn --push-web   # build, copy, run on it
node scripts/phone/lab/run.mjs --scenario locked-wrong-turn --web        # run on the copy again
```

Opened by hand, the app always runs the web app it was installed with. iOS may empty the
temporary folder at any time; then push again.

**2. Swift changes, or a build the owner will drive with: install the .ipa.** CI builds
`RouteIQ-unsigned` on every pull request and on `main` (`.github/workflows/shell-ios.yml`).

```powershell
gh run download <run id> -R akashdesai93/routeiq -n RouteIQ-unsigned -D $HOME\dev\routeiq-builds\candidate-<run id>
scripts\phone\lab\install-ipa.ps1 -Ipa $HOME\dev\routeiq-builds\candidate-<run id>\RouteIQ-unsigned.ipa
```

`install-ipa.ps1` presses the buttons of the Sideloadly window that is open: it chooses the file,
presses Start and waits for "Done." (4 seconds to 10 minutes on the first night; when it sat at
"Installing… 88%" for minutes, it finished soon after the lab next started an app on the phone). It never types or reads an Apple ID, a password or a code. If Sideloadly opens a
window of its own, the script stops and names the window; a person has to answer it. Installing
over the app keeps its data, the Mapbox token included, because Sideloadly gives the same bundle
id every time. A free Apple ID's signature lasts 7 days; Sideloadly's own refresh covers that.

### The rule for every build that goes on the phone

The phone is the owner's. It must never be left without a RouteIQ that works.

1. **Stage it.** Only `RouteIQ-unsigned` from a green Gate run of this repository, downloaded into
   `%USERPROFILE%\dev\routeiq-builds\<name>-<run id>\`.
2. **Keep the out.** The last build that passed on the phone stays in
   `routeiq-builds\known-good-<run id>\`. Do not delete it until a newer one has passed.
3. **Install over the app that is there** (never remove the app: that would lose the token).
4. **Test on the phone at once:** `starts-and-plans` (it starts; routes appear, so the token is
   still there), then `locked-wrong-turn`, and look at the screenshots.
5. **Keep it or roll back.** All checks passed and the screenshots look right: copy the ipa to
   `routeiq-builds\known-good-<run id>\`. Anything else (it does not start, the token screen
   shows, no GPS, a check fails, a crash report appears): install the known-good ipa again at
   once, run `starts-and-plans` to see it start, and report what failed.
6. **Always end with the simulated position cleared** and RouteIQ started normally, in front.

### A queue of builds, one report

`queue.mjs` does the rule above for several builds in a row and writes one report
(`phone-lab/queue-<time>/report.md`):

```powershell
node scripts/phone/lab/queue.mjs plan.json                      # now
node scripts/phone/lab/queue.mjs plan.json --wait-unlocked 12   # when the phone is next unlocked
```

```json
{
  "rollback": "C:/Users/me/dev/routeiq-builds/known-good-123/RouteIQ-unsigned.ipa",
  "builds": [
    { "name": "main + lab", "ipa": "C:/Users/me/dev/routeiq-builds/lab-main-456/RouteIQ-unsigned.ipa" },
    { "name": "PR 127 + lab", "ipa": "C:/.../RouteIQ-unsigned.ipa", "keep": false,
      "runs": [["--scenario", "starts-and-plans"], ["--scenario", "locked-wrong-turn", "--in-app"]] }
  ]
}
```

For each build: install it over the app, then its runs (by default `starts-and-plans`,
`drive-screen` and `locked-wrong-turn --in-app`; a build that does not start gets no drive). At
the end the phone is left on the last build that passed every run, or, when none did, on the
rollback build, which is then started to see its routes. A build with `"keep": false` is a
throwaway (a pull request's code plus the lab, built only to be measured) and is never the one
left on the phone. A run with `--lock` is refused.

`--wait-unlocked` reads one value from the phone every 10 minutes, presses nothing and starts
nothing while it is locked. When the phone is unlocked it waits two more minutes and looks again
before it begins, because someone who has just picked the phone up is using it. The queue's
default drive is the in-app test drive, so the phone's own position is not changed; the phone
does speak.

## Limits, said plainly

- A locked phone with a passcode cannot be opened from the PC: no app can be started on it. Builds
  can still be installed. The lockdown value `PasswordProtected` reads false while the phone is
  unlocked and true once it is locked; it does not say whether a passcode is set.
- `--lock` forces the phone to sleep, which is harsher than pressing the side button during a
  drive. On the first run (2026-11-11) the app stood still for 39 s right after it (no fix, no
  tick) and carried on when the PC next asked the phone for the report; from then on it ran
  with the screen off for three minutes. The tick check failed on that wait, as it should.
  Whether a normal lock does the same is not known from the lab; the owner's own locked drive
  the same evening had no such wait.
- With the phone asleep the car is the app's own made-up one. GPS delivered by iOS to a sleeping
  phone is not covered by any scenario: the connection that simulates the position does not
  survive sleep. The nearest thing is the default run (GPS over USB, app in the background).
- The phone is on the cable, so it is charging: the battery level says little about energy use.
  The report has CPU share and memory per minute and the battery temperature. An energy figure
  needs a run off the cable.
- The screenshots show what was on screen at two moments. What happened in between is in the
  diagnostics, not in a picture: nobody watched the screen while the app was away.
- The lab does not hear the voice. "Finished" is what the phone's speech engine reported.
