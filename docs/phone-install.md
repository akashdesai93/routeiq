# RouteIQ on your iPhone: install and first drive

This puts RouteIQ on the phone as an installed app, so a drive keeps going while the phone is
locked or another app is in front: GPS, the checks for a faster route, and the voice. A Safari
page cannot do that.

It is the same web app inside a small native shell (`native/shell`). The shell's Swift code owns
the GPS, the voice and the screen lock; everything else is the web code you already know.

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
gh run list --workflow shell-ios.yml --status success --limit 5
gh run download <run-id> -n RouteIQ-unsigned
```

That leaves `RouteIQ-unsigned.ipa` in the current folder. Or in the browser: the repository's
**Actions** tab, workflow **Shell iOS (unsigned ipa)**, the newest green run, **Artifacts** at the
bottom, `RouteIQ-unsigned` (a `.zip` with the `.ipa` inside). Artifacts are deleted after 30 days;
any change under `native/shell/` or `src/` builds a new one.

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
6. You should hear "RouteIQ started". If not: volume up, and check the mute button in the app's
   drive view. The ring/silent switch should not matter (the app uses the playback audio category).

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
   drive view should say "checked N s ago" with N under about a minute.
7. Tap **End**.

**If the voice stops when you lock the phone, do not rely on the app for the drive.** Note what
happened (which step, how long until silence, whether the blue indicator was showing) and use
the phone unlocked on a mount with the screen on instead: RouteIQ keeps the screen awake during a
drive, and with the app in front it behaves like the browser version.

## 5. On the drive

- Phone charged or on power; GPS at navigation accuracy uses the battery.
- Start the drive **before you move**, with the app in front. Then lock it or switch to music.
- The blue location indicator stays on for the whole drive. It goes away when you tap End or arrive.
- Listen for:
  - turn prompts at the usual distances;
  - "Switching to a faster route. Saves N minutes." if traffic changes;
  - after a phone call, the next prompt should come by itself.
- Glance only when stopped: "checked N s ago" in the drive view should never be many minutes old.
  If it is, route requests are not getting through in the background (see the first unverified item).
- Things worth writing down afterwards: any silence longer than expected, any prompt that came
  late (after the turn), whether audio came from the car, whether a switch was announced.
- **Do not touch the phone while moving.**

## What is unverified

Nobody has run this build on a device. In order of how much the drive depends on it:

1. **Route requests in the background.** Reroute checks are `fetch` calls made by the web page
   inside the app. The page is woken about once a second by native events while locked, which is
   the design; whether iOS always lets its network requests finish in the background is not
   measured. If they stall, the turn prompts for the current route still work, but no faster
   route is found and a wrong turn is not recovered until you open the app; a native request
   path is the fix.
2. **Web code running while locked at all.** The turn prompts are decided by the web code from each
   native GPS fix. The native side delivers fixes and a one-second tick to the page; iOS is
   expected to run the page for each. The probe app was built to measure exactly this and its
   results are not in the repository.
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
positions (a test in `native/shell/tests` checks the Swift for logging and file calls). The token
stays on the phone. The spoken text is made on the phone by iOS.
