# Simulating a drive on the iPhone from this PC

With the phone on the desk and plugged into the Windows PC, this makes it believe it is driving
from Uptown Charlotte to SouthPark Mall, takes a wrong turn on the way, and lets you hear what
RouteIQ does about it ("You are off the route. Finding a new one." and then "New route. …").
It is what Xcode's *Simulate Location* does, without a Mac: the open-source
[pymobiledevice3](https://github.com/doronz88/pymobiledevice3) replays a GPX track over USB.

> **This moves the whole phone, not only RouteIQ.** While a simulation is active, every app and
> service on the phone sees the simulated position: Find My (people you share your location with
> see you in Charlotte), Maps, Weather, photos you take, location-based reminders and automations.
> It stays that way until it is **cleared**. The script clears it when it ends, when it fails and
> on Ctrl+C. If you close the window or pull the cable instead, clear it yourself:
> `scripts\phone\sim-drive.ps1 -ClearOnly`. Restarting the phone also ends it.

Nothing is installed on the phone and no phone setting is changed. The tracks use public
landmarks only, are made on the PC without any network request, and are deleted after the run.

## What was checked, and what was not

On 2026-11-11, on this PC (Windows 11, pymobiledevice3 11.52.1) with the iPhone on iOS 26.6.1:

- `usbmux list` and `lockdown info` found the phone; Developer Mode was already on.
- `simulate-location set`, a 30-second replay of the `wrong-turn` track through
  `sim-drive.ps1`, and `simulate-location clear` all finished without an error, **in an ordinary
  terminal: no Administrator, no extra driver, no tap on the phone**. This version of
  pymobiledevice3 builds its own tunnel to the phone inside the command.
- **Not checked:** nobody looked at the phone while this ran. That the blue dot really moved, that
  the simulation keeps running while the phone is locked, and what RouteIQ says, are for the first
  run below to show.

## One-time setup

Already done on this PC on 2026-11-11; this is how to do it again (an ordinary PowerShell window,
not Administrator):

```powershell
py -m venv $HOME\dev\tools\pmd3
& $HOME\dev\tools\pmd3\Scripts\python.exe -m pip install pymobiledevice3
```

It lives in its own folder and leaves the system Python alone. The scripts look for it there; if
you put it elsewhere, set `ROUTEIQ_PMD3` to the full path of `pymobiledevice3.exe`.

The rest was already in place from installing the app (`docs/phone-install.md`): Apple Mobile
Device Support (it comes with iTunes or Apple Devices), the phone trusting this PC, and
Developer Mode on (Settings → Privacy & Security → Developer Mode).

Check that the PC sees the phone:

```powershell
& $HOME\dev\tools\pmd3\Scripts\pymobiledevice3.exe usbmux list
```

One entry with `"ConnectionType": "USB"` means it does. An empty list `[]`: see Troubleshooting.
(The output holds the phone's identifiers. Don't paste it into an issue.)

## A simulated drive with a wrong turn

1. Plug the phone in and **unlock it**. Turn the volume up.
2. On the PC, in the repository folder, in an ordinary PowerShell window:

   ```powershell
   scripts\phone\sim-drive.ps1 -Preset wrong-turn -FromM 4400 -HoldSec 90
   ```

   The phone now stands on Providence Road in Charlotte, about a kilometer before the wrong
   turn, and stays there for 90 seconds (`-HoldSec`). The window shows each position it sends.
3. On the phone, within those 90 seconds: open **RouteIQ**, tap **Use my location** for the
   origin (the pin should land on Providence Road in Charlotte; if it shows your real position,
   the simulation is not reaching the phone), search **SouthPark Mall** for the destination, pick
   the recommended route, and tap **Start drive**. You hear "RouteIQ started".
4. **Lock the phone** and listen. About 70 seconds after it sets off, the track turns left off
   Providence Road into Colville Road and runs along Scotland Avenue, up to 250 m from the route.
   Within about ten seconds of the turn you should hear **"You are off the route. Finding a new
   one."** and shortly after **"New route. … to your destination."**
5. To stop, press **Ctrl+C** in the PowerShell window (or wait for the drive to end and press
   ENTER). The script prints **"Cleared: the phone is back on its real GPS."** Check that line is
   there. If it is not: `scripts\phone\sim-drive.ps1 -ClearOnly`.
6. In RouteIQ, end the drive and open **Drive diagnostics** (`docs/phone-install.md`, step 6) to
   see what the phone did while it was locked.

Need longer than 90 seconds to plan the route? Use a larger `-HoldSec`: nothing moves until it is over.

### The drives

| `-Preset` | What it does | Length |
| --- | --- | --- |
| `uptown-to-southpark` | Trade and Tryon, South Tryon Street, East 3rd Street, Providence Road, South Wendover Road, Sharon Road, SouthPark Mall. Stays on the route. | 10.2 km, 13 min |
| `wrong-turn` (default) | The same, but 5.3 km in it turns left into Colville Road, runs along Scotland Avenue (parallel to Providence Road) and comes back to Providence Road 0.9 km later. | 10.6 km |
| `turn-around` | The same, but 4.4 km in it misses the left turn where Providence Road leaves Queens Road, carries on 450 m along Queens Road, turns around, comes back and takes the turn. | 11.1 km |

### Options

| PowerShell | Git Bash (`sim-drive.sh`) | Meaning |
| --- | --- | --- |
| `-Preset wrong-turn` | `--preset wrong-turn` | Which drive. |
| `-Speed 13` | `--speed 13` | Meters per second (13 is about 29 mph). One position is sent per second. |
| `-HoldSec 60` | `--hold 60` | Seconds standing at the start before setting off. |
| `-FromM 4400` | `--from-m 4400` | Skip the first 4400 m. Without it the wrong turn comes 6 min 50 s after setting off, the missed turn of `turn-around` after 5 min 40 s (try `-FromM 3500` for that one). |
| `-Seconds 120` | `--seconds 120` | Stop after this long. |
| `-Waypoints "lng,lat;lng,lat"` | `--waypoints "…"` | Your own corners instead of a preset, longitude first. |
| `-Gpx file.gpx` | `--gpx file.gpx` | Replay a GPX file you already have. |
| `-NoWait` | `--no-wait` | Clear as soon as the track ends, instead of holding the last position until ENTER. |
| `-ClearOnly` | `--clear-only` | Only clear the simulated location. |
| `-UseTunneld` | `--use-tunneld` | See "the built-in tunnel fails" below. |

To keep a track as a file: `node scripts/phone/make-gpx.mjs --preset turn-around --out turn-around.gpx`
(`--list` shows the presets).

### How close the track is to RouteIQ's route

The preset follows real streets (OpenStreetMap geometry, written into `scripts/phone/presets.mjs`),
but RouteIQ plans its own route with Mapbox, and with traffic that may be another one, for example
by Queens Road or Kings Drive. RouteIQ calls a position off the route when it is more than 50 m
from the line for 8 seconds. So:

- If the recommended route in RouteIQ follows Providence Road past Colville Road, the test is the
  wrong turn itself: quiet until the turn, then the two lines.
- If it does not, you hear "off the route" earlier, wherever the track and RouteIQ's route part.
  That still shows the locked phone noticing and finding a new route; it is just not at Colville Road.
  Starting close to the turn (`-FromM 4400`) makes this unlikely.

## Troubleshooting

**"running scripts is disabled on this system".** Start it this way instead (it changes nothing
permanently): `powershell -ExecutionPolicy Bypass -File scripts\phone\sim-drive.ps1 -Preset wrong-turn`.

**"No iPhone found over USB" / `usbmux list` prints `[]`.** Unlock the phone and look for a
**Trust This Computer?** prompt: tap Trust and enter the passcode. Try another cable or port (some
cables only charge). Check that *Apple Mobile Device Service* is running: `Get-Service "Apple Mobile Device Service"`.
If it is stopped, start it from an **Administrator** PowerShell: `Start-Service "Apple Mobile Device Service"`.
If there is no such service, install iTunes or Apple Devices.

**An error about pairing, a password-protected or locked device.** Unlock the phone and keep it
unlocked until the first position has been sent; you can lock it after that.

**An error naming Developer Mode.** Settings → Privacy & Security → Developer Mode → on; the phone
restarts and asks you to confirm. (Sideloadly turned this on already; iOS turns it off again only
if you do.)

**An error naming the developer disk image, `InvalidServiceError`, or "DeveloperDiskImage".** The
phone's developer image is not mounted. It was not needed on 2026-11-11. If it is asked for, with
the phone unlocked run
`& $HOME\dev\tools\pmd3\Scripts\pymobiledevice3.exe mounter auto-mount`
(it downloads the image from Apple, which signs it for this phone, and mounts it until the next
restart; ordinary terminal).

**The built-in tunnel fails** (the command stops after "Trying again over a no-root userspace
tunnel", or times out connecting). Keep a tunnel open the older way instead. This one **needs an
Administrator terminal**: Start → type *PowerShell* → *Run as administrator*, then

```powershell
& $HOME\dev\tools\pmd3\Scripts\pymobiledevice3.exe remote tunneld
```

Leave that window open. Allow it if Windows Firewall asks. Then, in the ordinary window:
`scripts\phone\sim-drive.ps1 -Preset wrong-turn -UseTunneld`. Close the Administrator window with
Ctrl+C when you are done.

**RouteIQ shows your real position.** The simulation is not active: look for an error in the
PowerShell window. Force-quit apps that hold a developer connection to the phone (Sideloadly, a
second copy of this script) and run it again.

**"CLEAR FAILED", or the phone still thinks it is in Charlotte.** Unlock the phone, check the
cable, and run `scripts\phone\sim-drive.ps1 -ClearOnly`. The command underneath is
`& $HOME\dev\tools\pmd3\Scripts\pymobiledevice3.exe developer dvt simulate-location clear`
(on iOS 16 and older: `developer simulate-location clear`). If nothing works, restart the phone:
that always ends a simulation. Then open Maps and check that the blue dot is where you are.

**Nothing is said.** Volume up, the ring/silent switch, Mute in the drive view. The first line
comes from the **Start drive** tap; a drive that was never started says nothing.

**pymobiledevice3 changed.** Its commands have moved between versions. This was written for
11.52.1: `pymobiledevice3 developer dvt simulate-location --help` shows what the installed one has.
To go back to that version: `python.exe -m pip install pymobiledevice3==11.52.1` in the venv.
