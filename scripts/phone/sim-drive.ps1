<#
.SYNOPSIS
  Simulates a drive on the iPhone plugged into this PC: makes a GPX track, replays it as the
  phone's location with pymobiledevice3, and always clears the simulated location at the end.

.DESCRIPTION
  See docs/phone-sim-location.md. While this runs, the WHOLE PHONE believes it is on the
  simulated drive (Find My, Maps, Weather, every app). The script clears that when it ends,
  when it fails and on Ctrl+C. If the window is closed or the cable pulled instead, run it
  again with -ClearOnly.

.EXAMPLE
  scripts\phone\sim-drive.ps1 -Preset wrong-turn
.EXAMPLE
  scripts\phone\sim-drive.ps1 -Preset wrong-turn -FromM 4400 -Speed 18
.EXAMPLE
  scripts\phone\sim-drive.ps1 -ClearOnly
#>
[CmdletBinding()]
param(
  # uptown-to-southpark, wrong-turn or turn-around (node scripts/phone/make-gpx.mjs --list).
  [string]$Preset = 'wrong-turn',
  # Driving speed in meters per second.
  [double]$Speed = 13,
  # Seconds the phone stands at the start before setting off: time to plan the route and tap Start drive.
  [int]$HoldSec = 60,
  # Skip this many meters of the drive, to start nearer the wrong turn.
  [int]$FromM = 0,
  # Stop after this many seconds (0: the whole drive).
  [int]$Seconds = 0,
  # Your own "lng,lat;lng,lat;..." instead of a preset.
  [string]$Waypoints = '',
  # Replay this GPX file instead of making one.
  [string]$Gpx = '',
  # Use a tunnel kept by `pymobiledevice3 remote tunneld` (started in an Administrator terminal)
  # instead of the built-in one that needs no Administrator.
  [switch]$UseTunneld,
  # Only clear the simulated location and stop.
  [switch]$ClearOnly,
  # When the drive is over, clear at once instead of waiting for ENTER.
  [switch]$NoWait
)

$ErrorActionPreference = 'Stop'

function Find-Pmd3 {
  $candidates = @(
    $env:ROUTEIQ_PMD3,
    (Join-Path $HOME 'dev\tools\pmd3\Scripts\pymobiledevice3.exe')
  ) | Where-Object { $_ }
  foreach ($candidate in $candidates) { if (Test-Path $candidate) { return $candidate } }
  $onPath = Get-Command pymobiledevice3 -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }
  throw "pymobiledevice3 was not found. Do the one-time setup in docs/phone-sim-location.md, or set ROUTEIQ_PMD3 to pymobiledevice3.exe."
}

$pmd3 = Find-Pmd3

# Which phone: only the model and the iOS version are shown, never its identifiers.
$listJson = & $pmd3 usbmux list 2>$null | Out-String
try { $devices = @($listJson | ConvertFrom-Json) } catch { $devices = @() }
$usb = @($devices | Where-Object { $_.ConnectionType -eq 'USB' })
if ($usb.Count -eq 0) {
  throw "No iPhone found over USB. Plug it in, unlock it, tap Trust if it asks, and check that Apple Mobile Device Support (iTunes or Apple Devices) is installed."
}
if ($usb.Count -gt 1) { Write-Warning "More than one device is plugged in; using the first. Unplug the others to be sure." }
$device = $usb[0]
$iosMajor = [int]($device.ProductVersion -split '\.')[0]
Write-Host "Found $($device.DeviceClass) ($($device.ProductType)), iOS $($device.ProductVersion)."

# iOS 17 and later take the simulated location through DVT; older ones through the older service.
$simulate = if ($iosMajor -ge 17) { @('developer', 'dvt', 'simulate-location') } else { @('developer', 'simulate-location') }
$deviceArgs = if ($UseTunneld) { @('--tunnel', $device.Identifier) } else { @() }

function Clear-SimulatedLocation {
  Write-Host "Clearing the simulated location..."
  & $pmd3 @simulate clear @deviceArgs
  if ($LASTEXITCODE -eq 0) {
    Write-Host "Cleared: the phone is back on its real GPS." -ForegroundColor Green
  } else {
    Write-Host "CLEAR FAILED. The phone may still report the simulated location." -ForegroundColor Red
    Write-Host "Unlock the phone, check the cable, then run:  scripts\phone\sim-drive.ps1 -ClearOnly" -ForegroundColor Red
    Write-Host "If that fails too, restart the phone: a restart always ends the simulation." -ForegroundColor Red
  }
}

if ($ClearOnly) {
  Clear-SimulatedLocation
  exit $LASTEXITCODE
}

$temporary = $null
$exitCode = 1
try {
  if ($Gpx -eq '') {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "node was not found (it makes the GPX track)." }
    $temporary = Join-Path ([IO.Path]::GetTempPath()) ("routeiq-sim-drive-{0}.gpx" -f $PID)
    $makeArgs = @((Join-Path $PSScriptRoot 'make-gpx.mjs'), '--speed', $Speed.ToString([Globalization.CultureInfo]::InvariantCulture),
      '--hold', $HoldSec, '--from-m', $FromM, '--seconds', $Seconds, '--out', $temporary)
    if ($Waypoints -ne '') { $makeArgs += @('--waypoints', $Waypoints) } else { $makeArgs += @('--preset', $Preset) }
    & node @makeArgs
    if ($LASTEXITCODE -ne 0) { throw "Could not make the GPX track." }
    $Gpx = $temporary
  } elseif (-not (Test-Path $Gpx)) { throw "No such GPX file: $Gpx" }

  Write-Host ""
  Write-Host "From now until 'Cleared', the whole phone reports the simulated location (Find My included)." -ForegroundColor Yellow
  if ($HoldSec -gt 0) {
    Write-Host "The phone stands at the start for $HoldSec s. In RouteIQ: Use my location, pick the destination, Start drive."
  }
  Write-Host "Ctrl+C stops the drive and clears the location."
  Write-Host ""

  # -NoWait gives the tool an empty input, so that it ends with the track instead of waiting for ENTER.
  if ($NoWait) { $null | & $pmd3 @simulate play $Gpx @deviceArgs } else { & $pmd3 @simulate play $Gpx @deviceArgs }
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    Write-Host "The replay failed (exit code $exitCode). See Troubleshooting in docs/phone-sim-location.md." -ForegroundColor Red
  }
} finally {
  # Runs on success, on failure and on Ctrl+C.
  Clear-SimulatedLocation
  if ($temporary -and (Test-Path $temporary)) { Remove-Item $temporary -Force }
}
exit $exitCode
