<#
  RouteIQ Windows prerequisite check. Read-only: it installs and changes nothing.

  Run from the project folder:
    powershell -NoProfile -ExecutionPolicy Bypass -File .\check-prereqs.ps1

  Works in Windows PowerShell 5.1 and PowerShell 7+.
  Exit code 0 = all required checks passed, 1 = at least one FAIL.
#>
[CmdletBinding()]
param(
  # Project folder to look for .env.local in. Defaults to this script's folder.
  [string]$ProjectDir = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'
# $PSScriptRoot can be empty while the param() defaults above are evaluated
# (seen in Windows PowerShell 5.1 with -File), so fall back here in the body.
if ([string]::IsNullOrWhiteSpace($ProjectDir)) { $ProjectDir = $PSScriptRoot }
if ([string]::IsNullOrWhiteSpace($ProjectDir)) { $ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
if ([string]::IsNullOrWhiteSpace($ProjectDir)) { $ProjectDir = (Get-Location).Path }
$script:failures = 0
$script:warnings = 0

function Write-Result {
  param([ValidateSet('PASS', 'WARN', 'FAIL', 'INFO')][string]$Status, [string]$Name, [string]$Detail, [string]$Fix)
  $color = @{ PASS = 'Green'; WARN = 'Yellow'; FAIL = 'Red'; INFO = 'Cyan' }[$Status]
  Write-Host ('[{0}] ' -f $Status) -ForegroundColor $color -NoNewline
  Write-Host ('{0}: {1}' -f $Name, $Detail)
  if ($Fix) { Write-Host ('       Fix: {0}' -f $Fix) -ForegroundColor DarkGray }
  if ($Status -eq 'FAIL') { $script:failures++ }
  if ($Status -eq 'WARN') { $script:warnings++ }
}

function Get-ToolVersion {
  # Returns the first line of "<tool> <args>", or $null when the tool is not on PATH.
  param([string]$Tool, [string[]]$ToolArgs = @('--version'))
  # On Windows prefer the .exe/.cmd shims, so npm.ps1 and friends never trip the execution policy.
  $names = @($Tool)
  if ($env:OS -eq 'Windows_NT') { $names = @("$Tool.exe", "$Tool.cmd", $Tool) }
  $cmd = $null
  foreach ($n in $names) {
    $cmd = Get-Command $n -CommandType Application, ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { break }
  }
  if (-not $cmd) { return $null }
  # In Windows PowerShell 5.1, 'Stop' turns any stderr line from a native tool into a
  # terminating error even with 2>$null, so relax it inside this function only.
  $ErrorActionPreference = 'Continue'
  try {
    $out = & $cmd.Source @ToolArgs 2>$null | Select-Object -First 1
    if ($null -eq $out) { return '' }
    return ([string]$out).Trim()
  } catch { return '' }
}

Write-Host ''
Write-Host 'RouteIQ prerequisite check (read-only)' -ForegroundColor White
Write-Host ('Project folder: {0}' -f $ProjectDir)
Write-Host ''

# --- Node.js -------------------------------------------------------------
# Vite 8 requires Node ^20.19.0 || >=22.12.0. Node 20 reached end of life in
# April 2026, so this check asks for 22.12+ and recommends an active LTS line
# (24 or 26). Source: vite engines field and nodejs.org release index, Nov 2026.
$nodeFix = 'Install Node.js 24 LTS or 26 LTS from https://nodejs.org (or: winget install OpenJS.NodeJS.LTS), then open a new terminal.'
$nodeRaw = Get-ToolVersion 'node' @('-v')
if ($null -eq $nodeRaw) {
  Write-Result FAIL 'Node.js' 'not found on PATH' $nodeFix
} elseif ($nodeRaw -notmatch '^v?(\d+)\.(\d+)\.(\d+)') {
  Write-Result FAIL 'Node.js' ("could not read version from '{0}'" -f $nodeRaw) $nodeFix
} else {
  $major = [int]$Matches[1]; $minor = [int]$Matches[2]
  $meetsVite = ($major -eq 20 -and $minor -ge 19) -or ($major -eq 22 -and $minor -ge 12) -or ($major -gt 22)
  $isLtsLine = ($major % 2 -eq 0)
  if (-not $meetsVite -or $major -lt 22) {
    Write-Result FAIL 'Node.js' ("{0} is too old or out of support (need 22.12+, recommend 24 or 26 LTS)" -f $nodeRaw) $nodeFix
  } elseif (-not $isLtsLine) {
    # Vitest 5 supports only ^22.12 || ^24 || >=26, so odd lines 23 and 25 are unsupported.
    if ($major -lt 26) {
      Write-Result FAIL 'Node.js' ("{0} is an odd, non-LTS release that Vitest 5 does not support" -f $nodeRaw) $nodeFix
    } else {
      Write-Result WARN 'Node.js' ("{0} is a short-lived odd release, not LTS" -f $nodeRaw) $nodeFix
    }
  } elseif ($major -eq 22) {
    Write-Result WARN 'Node.js' ("{0} works, but 22 is in maintenance until April 2027" -f $nodeRaw) $nodeFix
  } else {
    Write-Result PASS 'Node.js' ("{0} (LTS line, meets Vite 8)" -f $nodeRaw)
  }
}

# --- npm -----------------------------------------------------------------
$npmRaw = Get-ToolVersion 'npm' @('-v')
if ($null -eq $npmRaw) {
  Write-Result FAIL 'npm' 'not found on PATH' 'npm ships with Node.js. Reinstall Node.js LTS.'
} elseif ($npmRaw -match '^(\d+)\.' -and [int]$Matches[1] -ge 10) {
  Write-Result PASS 'npm' $npmRaw
} else {
  Write-Result WARN 'npm' ("{0} is old" -f $npmRaw) 'Update with: npm install -g npm@latest'
}

# --- pnpm (optional) -----------------------------------------------------
$pnpmRaw = Get-ToolVersion 'pnpm' @('-v')
if ($null -eq $pnpmRaw) {
  Write-Result INFO 'pnpm' 'not installed (optional, this project uses npm)' ''
} else {
  Write-Result INFO 'pnpm' ("{0} (optional, this project uses npm)" -f $pnpmRaw) ''
}

# --- Git -----------------------------------------------------------------
$gitRaw = Get-ToolVersion 'git' @('--version')
if ($null -eq $gitRaw) {
  Write-Result FAIL 'Git' 'not found on PATH' 'Install Git for Windows from https://git-scm.com (or: winget install Git.Git).'
} else {
  Write-Result PASS 'Git' $gitRaw
}

# --- VS Code -------------------------------------------------------------
$codeRaw = Get-ToolVersion 'code' @('--version')
if ($null -eq $codeRaw) {
  Write-Result WARN 'VS Code' "'code' command not on PATH" "Install VS Code, or in VS Code run 'Shell Command: Install code command in PATH', then open a new terminal."
} else {
  Write-Result PASS 'VS Code' $codeRaw
}

# --- Mapbox token --------------------------------------------------------
# The value is never printed, only its kind.
function Get-TokenKind([string]$Value) {
  $v = ''
  if ($null -ne $Value) { $v = $Value.Trim().Trim('"').Trim("'") }
  if ($v -eq '' -or $v -eq 'pk.your_public_token_here') { return 'missing' }
  if ($v.StartsWith('sk.')) { return 'secret' }
  if ($v.StartsWith('pk.')) { return 'public' }
  return 'malformed'
}

$tokenFix = 'Copy .env.example to .env.local and set VITE_MAPBOX_TOKEN=pk.... (a PUBLIC token from https://console.mapbox.com/account/access-tokens/).'
$envLocal = Join-Path $ProjectDir '.env.local'
$fileKind = 'missing'
if (Test-Path -LiteralPath $envLocal) {
  $line = Get-Content -LiteralPath $envLocal | Where-Object { $_ -match '^\s*VITE_MAPBOX_TOKEN\s*=' } | Select-Object -Last 1
  if ($line) { $fileKind = Get-TokenKind (($line -split '=', 2)[1]) }
}
$envKind = Get-TokenKind $env:VITE_MAPBOX_TOKEN

if ($fileKind -eq 'secret' -or $envKind -eq 'secret') {
  Write-Result FAIL 'Mapbox token' 'a SECRET token (sk.) is set. Browser apps must use a public pk. token.' 'Replace it with a public token, and rotate the secret token in the Mapbox console if it was ever shared.'
} elseif ($fileKind -eq 'public') {
  Write-Result PASS 'Mapbox token' 'public token found in .env.local (value not shown)'
} elseif ($envKind -eq 'public') {
  Write-Result PASS 'Mapbox token' 'public token found in the VITE_MAPBOX_TOKEN environment variable (value not shown)'
} elseif ($fileKind -eq 'malformed' -or $envKind -eq 'malformed') {
  Write-Result FAIL 'Mapbox token' 'VITE_MAPBOX_TOKEN is set but does not start with pk.' $tokenFix
} else {
  Write-Result FAIL 'Mapbox token' 'no VITE_MAPBOX_TOKEN in .env.local or the environment' $tokenFix
}

# Make sure a real .env file is not lying around where it could get committed.
if (Test-Path -LiteralPath (Join-Path $ProjectDir '.env')) {
  Write-Result WARN '.env file' 'a plain .env exists. Keep tokens in .env.local only.' 'Move the token to .env.local and delete .env.'
}

Write-Host ''
if ($script:failures -gt 0) {
  Write-Host ('{0} check(s) failed, {1} warning(s). Fix the FAIL lines, then run this again.' -f $script:failures, $script:warnings) -ForegroundColor Red
  exit 1
}
Write-Host ('All required checks passed ({0} warning(s)). Next: npm ci, then npm run dev.' -f $script:warnings) -ForegroundColor Green
exit 0
