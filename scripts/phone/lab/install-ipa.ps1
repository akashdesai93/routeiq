<#
.SYNOPSIS
  Installs a RouteIQ .ipa on the plugged-in iPhone by pressing the buttons of the Sideloadly
  window that is already open on this PC: choose the file, Start, wait for "Done.".

.DESCRIPTION
  See docs/phone-lab.md ("Installing a build"). Sideloadly signs with the Apple ID its owner
  saved in it. This script never types, reads or prints an Apple ID, a password or a code: it
  sets the .ipa path, presses Start and reads the status line. If Sideloadly opens any window
  of its own (a password, a two-factor code, an error), the script stops and says which window;
  a person has to answer it.

  Installing over the app that is there keeps its data (the Mapbox token), because Sideloadly
  gives the same bundle id every time.

.EXAMPLE
  scripts\phone\lab\install-ipa.ps1 -Ipa C:\Users\me\dev\routeiq-builds\known-good-123\RouteIQ-unsigned.ipa
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Ipa,
  # Give up after this many seconds.
  [int]$TimeoutSec = 600
)

$ErrorActionPreference = 'Stop'
$Ipa = (Resolve-Path $Ipa).Path
if ([IO.Path]::GetExtension($Ipa) -ne '.ipa') { throw "Not an .ipa file: $Ipa" }

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class RouteIQLabWin {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string name);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr dialog, int id);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr w, string text);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
}
"@

$auto = [System.Windows.Automation.AutomationElement]
$scope = [System.Windows.Automation.TreeScope]
function Find-Condition($property, $value) { New-Object System.Windows.Automation.PropertyCondition($property, $value) }

$sideloadly = Get-Process sideloadly -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $sideloadly) { throw "Sideloadly is not open. Open it (its window must be showing, with the phone and the Apple ID chosen) and run this again." }
$processId = $sideloadly.Id
function Get-Main { $auto::FromHandle((Get-Process -Id $processId).MainWindowHandle) }

# Sideloadly's own windows on top of the main one. Anything but the file chooser needs a person.
function Get-Dialogs {
  @((Get-Main).FindAll($scope::Children, (Find-Condition $auto::ControlTypeProperty ([System.Windows.Automation.ControlType]::Window))) | ForEach-Object { $_.Current.Name })
}
# The status line and the percentage. Text with an @ in it (the Apple ID) is never read out.
function Get-Status {
  $texts = (Get-Main).FindAll($scope::Descendants, (Find-Condition $auto::ControlTypeProperty ([System.Windows.Automation.ControlType]::Text)))
  @($texts | ForEach-Object { $_.Current.Name } | Where-Object { $_ -and $_ -notmatch '@' -and $_ -notin 'iDevice:', 'Apple ID:' -and $_ -notmatch '\.ipa$' }) -join ' '
}
# Presses a button without waiting for what it opens (a file chooser would block the call).
function Press-Later([scriptblock]$find) {
  Start-Job -ArgumentList $processId, $find.ToString() -ScriptBlock {
    param($processId, $find)
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
    $main = [System.Windows.Automation.AutomationElement]::FromHandle((Get-Process -Id $processId).MainWindowHandle)
    $button = & ([scriptblock]::Create($find)) $main
    $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  } | Out-Null
}

$open = Get-Dialogs
if ($open.Count -gt 0) { throw "Sideloadly has a window open that needs a person: '$($open -join "', '")'. Nothing was changed." }

# 1. The file: the first button of the window opens "Choose IPA File".
Press-Later { param($main) $main.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'QPushButton')))[0] }
$dialog = [IntPtr]::Zero
for ($i = 0; $i -lt 40 -and $dialog -eq [IntPtr]::Zero; $i++) {
  Start-Sleep -Milliseconds 500
  $candidate = [IntPtr]::Zero
  while (($candidate = [RouteIQLabWin]::FindWindowEx([IntPtr]::Zero, $candidate, '#32770', 'Choose IPA File')) -ne [IntPtr]::Zero) {
    $owner = 0
    [void][RouteIQLabWin]::GetWindowThreadProcessId($candidate, [ref]$owner)
    if ($owner -eq $processId) { $dialog = $candidate; break }
  }
}
if ($dialog -eq [IntPtr]::Zero) { throw "Sideloadly's file chooser did not open." }
$combo = [RouteIQLabWin]::GetDlgItem($dialog, 0x47C)
$edit = [RouteIQLabWin]::FindWindowEx([RouteIQLabWin]::FindWindowEx($combo, [IntPtr]::Zero, 'ComboBox', $null), [IntPtr]::Zero, 'Edit', $null)
if ($edit -eq [IntPtr]::Zero) { throw "The file chooser has no file name box." }
[void][RouteIQLabWin]::SendMessage($edit, 0x000C, [IntPtr]::Zero, $Ipa)          # WM_SETTEXT
Start-Sleep -Milliseconds 400
[void][RouteIQLabWin]::PostMessage([RouteIQLabWin]::GetDlgItem($dialog, 1), 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)  # BM_CLICK on Open
for ($i = 0; $i -lt 20 -and [RouteIQLabWin]::IsWindow($dialog); $i++) { Start-Sleep -Milliseconds 500 }
if ([RouteIQLabWin]::IsWindow($dialog)) { throw "The file chooser did not take the file." }
Write-Host "File chosen: $(Split-Path $Ipa -Leaf) from $(Split-Path (Split-Path $Ipa -Parent) -Leaf)"

# 2. Start, then the status line until "Done.".
Press-Later { param($main) $main.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, 'Start'))) }
$deadline = (Get-Date).AddSeconds($TimeoutSec)
$last = ''
$sawProgress = $false
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 2
  $dialogs = Get-Dialogs
  if ($dialogs.Count -gt 0) {
    Write-Host "STOPPED: Sideloadly opened a window that needs a person: '$($dialogs -join "', '")'." -ForegroundColor Red
    exit 3
  }
  $status = Get-Status
  if ($status -ne $last) { Write-Host ("{0:HH:mm:ss} {1}" -f (Get-Date), $status); $last = $status }
  if ($status -notmatch '^Done\.') { $sawProgress = $true }
  elseif ($sawProgress) { Write-Host "Installed." -ForegroundColor Green; exit 0 }
  if ($sawProgress -and $status -match 'rror|ailed|uard|xpired|imit') {
    Write-Host "STOPPED: Sideloadly reports: $status" -ForegroundColor Red
    exit 2
  }
}
Write-Host "STOPPED: no 'Done.' from Sideloadly within $TimeoutSec s (last: $last)." -ForegroundColor Red
exit 4
