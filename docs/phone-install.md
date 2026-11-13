# RouteIQ on your iPhone: install and first drive

This puts RouteIQ on the phone as an installed app, so a drive keeps going while the phone is
locked or another app is in front: GPS, the checks for a faster route, and the voice. A Safari
page cannot do that.

It is the same web app inside a small native shell (`native/shell`). The shell's Swift code owns
the GPS, the voice, the screen lock and the route requests to Mapbox (native networking, so a
route check goes out while the phone is locked); everything else is the web code you already know.
After a drive, **Drive diagnostics** in the top bar tells us what iOS did: see step 6.

> **Nobody has run this on a phone yet.** The build compiles and its checks pass on GitHub's Mac,
> and the web side is tested against a stand-in for the native code. What iOS really does with the
> phone locked is unverified until you do the 10-minute check below. The list of what is unverified
> is at the end. Do the check at home before you rely on it in the car.

## What you need

- The iPhone, its cable, and this Windows PC.
- A Mapbox **public** token (`pk.`) **without a URL restriction**. Your browser token is restricted
  to `http://localhost:5173`, and a URL-restricted token does not work inside the app (the app's
  pages are served from `capacitor://localhost`, which Mapbox's URL list cannot hold). Create a
  separate token for the phone at https://console.mapbox.com/account/access-tokens/ with the
  default public scopes, so you can delete it without touching the browser one. Never a secret
  `sk.` token; the app refuses one.
- An Apple ID for signing. Read "Before you type your Apple ID" below first.

## 1. Download the app file

The build runs on GitHub Actions and produces an **unsigned** `.ipa`. It contains no Mapbox token
(the build fails if it finds one).

```bash
# the newest build: the id of the run that made it, then the download
gh api "repos/akashdesai93/routeiq/actions/artifacts?name=RouteIQ-unsigned&per_page=1" --jq ".artifacts[0].workflow_run.id"
gh run download <run-id> -n RouteIQ-unsigned
```

That leaves `RouteIQ-unsigned.ipa` in the current folder. Or in the browser: the repository's
**Actions** tab, workflow **Gate**, the newest green run that has a **shell-ios** job, **Artifacts**
at the bottom, `RouteIQ-unsigned` (a `.zip` with the `.ipa` inside). Artifacts are deleted after 30 days;
a pull request that changes `native/shell/` (or the web build files) builds a new one, every
push to `main` that changes `native/shell/`, `src/` or `public/` does too (so the newest green
`main` run has the current app), and `gh workflow run shell-ios.yml`
builds one on demand (that run is then under the workflow **Shell iOS (unsigned ipa)**).

## 2. Install it from Windows with a free Apple ID

An unsigned app cannot be installed as it is. A sideloading tool signs in to Apple as you, gets a
free 7-day development certificate, signs the `.ipa` and installs it. Three tools do this:
**Sideloadly**, **AltStore Classic** and **SideStore**. For one drive, Sideloadly has the fewest
moving parts. The comparison table is in the probe's README (`native/probe/README.md` on the
`native-probe` branch); the short version:

| | Sideloadly | AltStore Classic | SideStore |
| --- | --- | --- | --- |
| What it is | Windows program | Windows helper (AltServer) plus an app on the phone | App on the phone; PC only for first setup |
| Needs on the PC | iTunes and iCloud from Apple's website, not the Microsoft Store versions | The same; AltServer run as administrator | iTunes (USB driver) and `iloader` |
| Installing the `.ipa` | Drag the file in, enter the Apple ID, press Start, phone on USB | AltServer tray icon, "Sideload .ipa" | "+" in My Apps |
| Past 7 days | Re-signs when the phone is reachable | Refreshes on the same Wi-Fi | Refreshes on the phone |

Download them only from their own sites: sideloadly.io, altstore.io, sidestore.io. None of them was
run from here, so check the tool's own site for your iOS version on the day.

**Apple's limits with a free Apple ID, whichever tool:**

- The app **stops opening after 7 days** unless it is re-signed. Install it the day before the
  drive, not a week before.
- At most 3 sideloaded apps on a device, and about 10 new app ids per 7 days.
- The tool rewrites the bundle id (`dev.routeiq.shell` is a placeholder).

**Before you type your Apple ID.** You are typing an Apple ID and password into a third-party
tool. Each says the credentials go only to Apple; that cannot be verified from here. The usual
precaution is a **separate Apple ID made only for this**, not the one with your purchases, photos
and payment methods. The signing Apple ID does not need to be the one signed in on the phone.

## 3. First launch on the phone

1. **Trust the developer profile.** Settings > General > VPN & Device Management > under
   "Developer App" tap your Apple ID > Trust. Until then the app refuses to open.
2. **Developer Mode** (iOS 16 and later). Settings > Privacy & Security > Developer Mode > On. The
   phone restarts and asks again. If the switch is not listed, try opening the app once first.
3. Open **RouteIQ**. It shows **Paste your Mapbox public token**. Paste the phone's `pk.` token
   and tap **Save token**. This happens once; the token is kept on the phone only. **Change token**
   in the top bar replaces it later.
   - "Mapbox rejected the token (401)": the token is wrong or deleted. Change token.
   - "Mapbox refused the token for this app (403)": the token has a URL restriction. Use one without.
4. Set the destination and wait for the routes, as in the browser.
5. Tap **Start drive**. iOS asks for location:
   - Choose **Allow While Using App**. That is enough for a drive you start yourself: once
     started with the app in front, the GPS keeps coming with the phone locked, and iOS shows a
     blue location indicator at the top of the screen. That indicator is expected.
   - A second question may follow, now or later: **Change to Always Allow**. Either answer works
     for a drive. "Always" is the safer choice if iOS ever stops the GPS in the background with
     "While Using"; nobody has measured that on this app.
   - Leave **Precise Location** on.
   - If you tapped "Don't Allow": Settings > Privacy & Security > Location Services > RouteIQ.
6. You should hear "RouteIQ started". If not: volume up, and check Voice behind More in the app's
   drive view. The ring/silent switch should not matter (the app uses the playback audio category).

**A black screen right after an install** (#136). The first launch after an install, or after
the app was ended while in front and opened again at once, can stay black: nothing of the app is
shown, the map, the buttons and the token screen included. It is iOS not presenting the app's
window, not the page or the map, and it does not happen to a drive started normally. To get past it,
swipe RouteIQ away in the app switcher (swipe up from the bottom edge and hold, then flick
RouteIQ up), wait a few seconds and open it again from its icon. Going to the Home Screen and
back works too. After that it draws, and later launches and drives are not affected. If a drive
itself ever goes black, that is a different problem: send the diagnostics (step 6).

## 4. The 10-minute check, at home, before the drive

Do this on foot or parked. It is the only real test of the thing this app exists for.

1. Start a drive to somewhere a few miles away. Hear "RouteIQ started".
2. **Lock the phone** with the side button. Put it in your pocket.
3. Walk (or have someone drive you) for 5 minutes, going the **wrong way** on purpose.
   - Within about a minute you should hear "You are off the route. Finding a new one." and then
     "New route. N minutes to your destination." **while the phone is still locked.** That one
     sequence proves all three things: the GPS arrived, a route request went out and came back,
     and the voice spoke, all in the background.
4. Start some music, lock again. When RouteIQ speaks, the music should get quieter, then return.
5. Unlock, open another app (Messages) for two minutes, keep moving. The voice should continue.
6. Open RouteIQ. The map should be where you are, not where you were when you locked it, and the
   drive view should say "checked N s ago" (behind More) with N under about a minute.
7. Tap **End**.
8. Tap **Drive diagnostics** in the top bar, then **Copy**, and send what it copied (step 6 below).
   Do this even if everything worked.

**If the voice stops when you lock the phone, do not rely on the app for the drive.** Note what
happened (which step, how long until silence, whether the blue indicator was showing) and use
the phone unlocked on a mount with the screen on instead: RouteIQ keeps the screen awake during a
drive, and with the app in front it behaves like the browser version.

## Test at home: a simulated drive (Test drive)

You can try a whole drive, a wrong turn included, on the couch with the phone locked. The app
drives a **made-up car** along the route you selected instead of using the phone's GPS. The car is
moved by the app's native code, so it keeps going while the phone is locked, like a real drive.

1. Open **RouteIQ**, set the destination and wait for the routes. Tap the route you want to drive.
2. Scroll to just under the **Start drive** button and tick **Test drive (simulated GPS)**.
3. Tap what the car should do:
   - **Follow the route**: it drives the route to the end.
   - **Wrong turn after 1 min**: after a minute it turns off onto a made-up side street and keeps
     going. This is the one to start with.
   - **Turn around after 1 min**: after a minute it makes a U-turn and drives back the way it came
     for a while, then stops.
4. Tap **1× speed** or **3× speed**. At 3× the car covers the road three times as fast, so the
   "1 min" comes after 20 seconds. The clock, and the once-a-minute checks for a faster route,
   stay in real time.
5. Tap **Start drive**. You hear "RouteIQ started". The drive view shows a yellow **SIMULATED GPS**
   badge over the map, on the right, for the whole drive. iOS may ask for location: allow it, as for a real drive (see below).
6. **Lock the phone.** With **Wrong turn** you should hear, about 10 seconds after the turn,
   "You are off the route. Finding a new one." and then "New route. N minutes to your
   destination." The car then follows the new route, and you hear its turns.
7. To look at the diagnostics without ending the drive: unlock, tap **More**, then **Drive
   diagnostics**, read or **Share**, then **Close**.
8. Tap **End** when you have heard enough. A test drive does not end by itself unless the car
   reaches the destination. Untick **Test drive (simulated GPS)** before a real drive; it is also
   off again every time the app is opened.

Things to know:

- **The route requests are real.** Each new route and each check for a faster one is a real
  request to Mapbox with your token, and counts against the drive's request budget ("N of 60
  requests", behind More in the drive view) and your Mapbox account, the same as on a real drive.
- **The traffic is real too**, for wherever the made-up car is. The side street of the wrong turn
  is not a real road: it is a straight line off the route, and Mapbox answers from the nearest
  real road.
- **The phone's GPS is switched on during a test drive, and its positions are thrown away.** It is
  on only because that is what makes iOS keep the app running while locked; the blue location
  indicator shows, as on a real drive. Where the phone really is never reaches the drive, the
  map or Mapbox. If you refused the location permission, the test drive cannot start either.
- **Turn around** stays on the same road, so the app does not call it "off the route". Use it to
  see what the app says and does when you drive the wrong way along the route; note what you
  hear.
- The diagnostics of a test drive say so: `SIMULATED GPS test drive: wrong-turn, 3x speed`.

## 5. On the drive

- Phone charged or on power; GPS at navigation accuracy uses the battery.
- Start the drive **before you move**, with the app in front. Then lock it or switch to music.
- The blue location indicator stays on for the whole drive. It goes away when you tap End or arrive.
- Listen for:
  - turn prompts at the usual distances;
  - "Switching to a faster route. Saves N minutes." if traffic changes;
  - after a phone call, the next prompt should come by itself.
- Glance only when stopped: "checked N s ago" (behind More in the drive view) should never be many minutes old.
  If it is, route checks are not happening in the background (see the first two unverified items).
- Things worth writing down afterwards: any silence longer than expected, any prompt that came
  late (after the turn), whether audio came from the car, whether a switch was announced.
- **Do not touch the phone while moving.**

## 6. After the drive: send the diagnostics

The app keeps a small log of what iOS let it do. It is the only way to tell from here what
happened while the phone was locked, so please send it after every test drive, good or bad.

1. When parked, end the drive (**End**, or **Done** after arriving). The top bar comes back.
2. Tap **Drive diagnostics** in the top bar, then **Share**. The iPhone's share sheet opens: pick
   Messages, Mail, Notes or AirDrop. Or tap **Copy** (it says "Copied.") and paste it yourself.
   If Copy says it could not copy: press and hold the text, **Select All**, **Copy**.
3. Send it with a line about what you heard and saw.

During a drive the same log is behind **More**, then **Drive diagnostics**, in the drive view.

**If the app was closed in between** (swiped away, or iOS ended it), the last drive is still
there: the app writes the log to its own storage when a drive ends and about every 30 seconds
during one. Open **Drive diagnostics** and it shows **Last drive (saved ...)**; **Since the app
opened** next to it is the log of the current launch. Only the one last drive is kept; the next
drive replaces it.

What it holds: how many GPS fixes and clock ticks arrived (and how many of them while the app was
not in front), the longest wait between them, each route request with how long it took, how many
spoken lines started and finished, and the times the app went to the background and came back.
It holds **no positions, no addresses and no token**: counts, times of day and milliseconds only,
so it is safe to paste anywhere.

How to read it yourself:

- `ticks: 3200 (2900 while not active), longest gap 1 s`: the web code kept running while locked.
  A line like `no tick for 45 s [background]` means iOS paused it.
- `requests: 14 sent (12 while not active), 14 answered, 0 failed`: route checks got through
  while locked. `timeout` or `network` lines are requests that did not.
- `speech: 22 lines started, 22 finished`: every line was spoken to the end.

## What is unverified

Nobody has run this build on a device. In order of how much the drive depends on it:

1. **Web code running while locked at all.** The turn prompts and the decision to check for a
   faster route are made by the web code from each native GPS fix. The native side delivers fixes
   and a one-second tick to the page; iOS is expected to run the page for each. The probe app was
   built to measure exactly this and its results are not in the repository. Drive diagnostics shows
   it directly: "ticks ... while not active" should keep counting, and a line "no tick for N s
   [background]" is iOS not running the web code.
2. **Route requests in the background.** These no longer depend on the web view: route checks go
   out through native networking (iOS's own `URLSession`), as the GPS and the voice already do.
   That removes the known risk of a web page's requests being held back while locked. It is still
   not measured on a phone; Drive diagnostics lists every request with its time and whether it was
   sent in the background. A request needs the web code to ask for it, so item 1 comes first.
3. **Speech while locked**, over music, over CarPlay or Bluetooth, and resuming after a phone
   call. The audio session is the probe's (`.playback`, `.voicePrompt`, ducking), which compiled
   but whose drive results are also not recorded.
4. **"While Using" versus "Always"** for an hour-long locked drive.
5. **The sideloading tool** on your iOS version.
6. **The map inside the app** (Mapbox GL in the app's web view), the layout around the notch, and
   "Use my location".
7. **Token storage.** The token is in the app's web storage. iOS can clear that when the phone is
   very low on space; the app then asks for the token again.

## Privacy

Same rules as the browser version. Your position goes from the phone's GPS to the app's memory
and to Mapbox as the start of a route request, nowhere else. The native code does not log or store
positions (a test in `native/shell/tests` checks the Swift for logging and file calls). Route
requests are sent by the app's native code, to `api.mapbox.com` only; the address of a request
(which holds the token and the position) is never logged. The token stays on the phone. The spoken
text is made on the phone by iOS. Drive diagnostics holds counts and timings only. The last
drive's diagnostics are also kept in the app's storage on the phone (the same text: no position,
no address, no token; a text that looked like it held one would not be written). They leave the
phone only when you share or copy and send them. A test drive uses made-up positions; the phone's
own position is discarded during one.
