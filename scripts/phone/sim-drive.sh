#!/usr/bin/env bash
# Simulates a drive on the iPhone plugged into this computer: makes a GPX track, replays it as
# the phone's location with pymobiledevice3, and always clears the simulated location at the
# end. See docs/phone-sim-location.md. The same as sim-drive.ps1, for Git Bash, macOS and Linux.
#
# While this runs, the WHOLE PHONE believes it is on the simulated drive (Find My, Maps, every
# app). The script clears that when it ends, when it fails and on Ctrl+C. If the window is closed
# or the cable pulled instead, run it again with --clear-only.
#
#   scripts/phone/sim-drive.sh --preset wrong-turn
#   scripts/phone/sim-drive.sh --preset wrong-turn --from-m 4400 --speed 18
#   scripts/phone/sim-drive.sh --clear-only
set -u

usage() {
  cat <<'EOF'
Usage: scripts/phone/sim-drive.sh [options]
  --preset <name>     uptown-to-southpark | wrong-turn | turn-around (default wrong-turn)
  --speed <m/s>       driving speed (default 13)
  --hold <seconds>    stand at the start this long before setting off (default 60)
  --from-m <meters>   skip this much of the drive
  --seconds <n>       stop after n seconds
  --waypoints <list>  your own "lng,lat;lng,lat;..." instead of a preset
  --gpx <file>        replay this GPX file instead of making one
  --use-tunneld       use a tunnel kept by `pymobiledevice3 remote tunneld` (started as Administrator/root)
  --no-wait           when the drive is over, clear at once instead of waiting for ENTER
  --clear-only        only clear the simulated location
EOF
}

preset=wrong-turn speed=13 hold=60 from_m=0 seconds=0 waypoints='' gpx='' use_tunneld=0 no_wait=0 clear_only=0
while [ $# -gt 0 ]; do
  case "$1" in
    --preset) preset=${2:?--preset needs a name}; shift 2 ;;
    --speed) speed=${2:?--speed needs a number}; shift 2 ;;
    --hold) hold=${2:?--hold needs a number}; shift 2 ;;
    --from-m) from_m=${2:?--from-m needs a number}; shift 2 ;;
    --seconds) seconds=${2:?--seconds needs a number}; shift 2 ;;
    --waypoints) waypoints=${2:?--waypoints needs a list}; shift 2 ;;
    --gpx) gpx=${2:?--gpx needs a file}; shift 2 ;;
    --use-tunneld) use_tunneld=1; shift ;;
    --no-wait) no_wait=1; shift ;;
    --clear-only) clear_only=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

here=$(cd "$(dirname "$0")" && pwd)

# Where pymobiledevice3 is: ROUTEIQ_PMD3, the venv of the one-time setup, or the PATH.
pmd3=''
for candidate in "${ROUTEIQ_PMD3:-}" "$HOME/dev/tools/pmd3/Scripts/pymobiledevice3.exe" "$HOME/dev/tools/pmd3/bin/pymobiledevice3"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then pmd3=$candidate; break; fi
done
[ -n "$pmd3" ] || pmd3=$(command -v pymobiledevice3 || true)
if [ -z "$pmd3" ]; then
  echo "pymobiledevice3 was not found. Do the one-time setup in docs/phone-sim-location.md, or set ROUTEIQ_PMD3." >&2
  exit 1
fi

# Which phone: only the model and the iOS version are shown, never its identifiers.
info=$("$pmd3" usbmux list 2>/dev/null | node -e '
  let text = ""
  process.stdin.on("data", (chunk) => (text += chunk)).on("end", () => {
    let devices = []
    try { devices = JSON.parse(text) } catch {}
    const usb = devices.filter((device) => device.ConnectionType === "USB")
    if (usb.length > 0) console.log([usb.length, usb[0].ProductVersion, usb[0].ProductType, usb[0].Identifier].join(" "))
  })')
if [ -z "$info" ]; then
  echo "No iPhone found over USB. Plug it in, unlock it, tap Trust if it asks, and check that Apple Mobile Device Support (iTunes or Apple Devices) is installed." >&2
  exit 1
fi
read -r count ios_version model identifier <<<"$info"
[ "$count" -gt 1 ] && echo "More than one device is plugged in; using the first. Unplug the others to be sure." >&2
echo "Found $model, iOS $ios_version."

# iOS 17 and later take the simulated location through DVT; older ones through the older service.
if [ "${ios_version%%.*}" -ge 17 ]; then simulate=(developer dvt simulate-location); else simulate=(developer simulate-location); fi
device_args=()
[ "$use_tunneld" = 1 ] && device_args=(--tunnel "$identifier")

clear_location() {
  echo "Clearing the simulated location..."
  if "$pmd3" "${simulate[@]}" clear ${device_args[@]+"${device_args[@]}"}; then
    echo "Cleared: the phone is back on its real GPS."
  else
    echo "CLEAR FAILED. The phone may still report the simulated location." >&2
    echo "Unlock the phone, check the cable, then run:  scripts/phone/sim-drive.sh --clear-only" >&2
    echo "If that fails too, restart the phone: a restart always ends the simulation." >&2
    return 1
  fi
}

if [ "$clear_only" = 1 ]; then
  clear_location
  exit $?
fi

temporary=''
finish() {
  trap - EXIT INT TERM
  clear_location
  [ -n "$temporary" ] && rm -f "$temporary"
}
# Runs on success, on failure and on Ctrl+C.
trap finish EXIT
trap 'exit 130' INT TERM

if [ -z "$gpx" ]; then
  temporary="${TMPDIR:-${TEMP:-/tmp}}/routeiq-sim-drive-$$.gpx"
  make_args=(--speed "$speed" --hold "$hold" --from-m "$from_m" --seconds "$seconds" --out "$temporary")
  if [ -n "$waypoints" ]; then make_args+=(--waypoints "$waypoints"); else make_args+=(--preset "$preset"); fi
  node "$here/make-gpx.mjs" "${make_args[@]}" || { echo "Could not make the GPX track." >&2; exit 1; }
  gpx=$temporary
elif [ ! -f "$gpx" ]; then
  echo "No such GPX file: $gpx" >&2
  exit 1
fi

echo
echo "From now until 'Cleared', the whole phone reports the simulated location (Find My included)."
[ "$hold" -gt 0 ] && echo "The phone stands at the start for $hold s. In RouteIQ: Use my location, pick the destination, Start drive."
echo "Ctrl+C stops the drive and clears the location."
echo

# --no-wait gives the tool an empty input, so that it ends with the track instead of waiting for ENTER.
if [ "$no_wait" = 1 ]; then
  "$pmd3" "${simulate[@]}" play "$gpx" ${device_args[@]+"${device_args[@]}"} </dev/null
else
  "$pmd3" "${simulate[@]}" play "$gpx" ${device_args[@]+"${device_args[@]}"}
fi
code=$?
[ "$code" -ne 0 ] && echo "The replay failed (exit code $code). See Troubleshooting in docs/phone-sim-location.md." >&2
exit "$code"
