# Runs the BUILT router as a durable background service on Windows.
#
# Why this exists: `npm run dev` runs the server through `tsx watch` under
# `concurrently`, which is glued to the terminal that launched it — closing that
# terminal (or restarting the editor/agent host that spawned it) silently takes
# your /v1 endpoint down with it. This script runs the production artifact
# instead (`node server/dist/index.js`, exactly what the Dockerfile's CMD does),
# detached from any shell, and restarts it if it dies.
#
# It sets NODE_ENV=production and PORT for the supervised child process only
# (never in your shell). Production mode is the intended deployment target
# and this script is only used for that, but the DB path and
# .env resolution are both anchored to this file's location rather than the
# working directory (see server/src/db/index.ts and server/src/env.ts), so the
# same database and encryption key are used either way. The switch from `src`
# to `dist` moves __dirname from `server/src/db` to `server/dist/db` — same
# depth, therefore the same `server/data/freeapi.db`.
#
#   pwsh -File scripts/router-service.ps1 start     # start detached + supervise
#   pwsh -File scripts/router-service.ps1 stop
#   pwsh -File scripts/router-service.ps1 restart
#   pwsh -File scripts/router-service.ps1 status
#   pwsh -File scripts/router-service.ps1 autostart-install
#   pwsh -File scripts/router-service.ps1 autostart-remove
#
# autostart-* uses the per-user Startup folder rather than a Windows service or
# a Scheduled Task. A service would survive a headless boot, but installing one
# needs elevation, and this router is single-user and local-only by design — it
# only has to be there once you are. The Startup folder needs no admin and
# removing the entry is deleting one file.
#
# Structure (data flows one way: Paths -> Store/Health -> Lifecycle -> CLI):
#   Paths     : $RepoRoot/$DataDir/$LogDir/pid+log paths, Get-Port, Get-AutostartPath.
#   Pid store : sole owner of the pid files (Read-LivePid/Write-PidFile/
#               Clear-PidFiles, composed by Get-RouterState). Nothing else
#               touches the pid files directly.
#   Health    : sole owner of endpoint probing (Test-RouterAlive). Status and
#               wait paths consume it; they never call Invoke-WebRequest directly.
#   Lifecycle : Start/Stop/Run/Autostart consume Store+Health. CLI only dispatches.

param(
  [ValidateSet('start', 'stop', 'restart', 'status', 'foreground', 'autostart-install', 'autostart-remove')]
  [string]$Action = 'start'
)

$ErrorActionPreference = 'Stop'

# --- Paths: derived once, consumed by everything below. ---
$RepoRoot = Split-Path -Parent $PSScriptRoot
$DataDir = Join-Path $RepoRoot 'server\data'
$LogDir = Join-Path $DataDir 'logs'
$PidFile = Join-Path $DataDir 'router.pid'
$ChildPidFile = Join-Path $DataDir 'router.child.pid'
$OutLog = Join-Path $LogDir 'router.log'
$ErrLog = Join-Path $LogDir 'router.error.log'
$Entry = Join-Path $RepoRoot 'server\dist\index.js'

function Get-AutostartPath {
  return Join-Path ([Environment]::GetFolderPath('Startup')) 'FreeLLMAPI Router.cmd'
}

function Get-Port {
  # .env is the source of truth when it names a port; 3001 matches the default
  # in server/src/lib/config.ts.
  $envFile = Join-Path $RepoRoot '.env'
  if (Test-Path $envFile) {
    $m = Select-String -Path $envFile -Pattern '^\s*PORT\s*=\s*(\d+)' | Select-Object -First 1
    if ($m) { return [int]$m.Matches[0].Groups[1].Value }
  }
  return 3001
}

# --- Pid store: the only functions that read or write the pid files. ---
function Read-LivePid {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return $null }
  $raw = (Get-Content $Path -Raw).Trim()
  if (-not $raw) { return $null }
  $procId = 0
  if (-not [int]::TryParse($raw, [ref]$procId)) { return $null }
  if (Get-Process -Id $procId -ErrorAction SilentlyContinue) { return $procId }
  # Stale file: the process it named is gone. Don't delete it here — callers
  # that are entitled to decide (start/stop) clear it via Clear-PidFiles.
  return $null
}

function Write-PidFile {
  param([string]$Path, [int]$ProcId)
  Set-Content -Path $Path -Value $ProcId -Encoding ascii
}

function Clear-PidFiles {
  Remove-Item $PidFile, $ChildPidFile -ErrorAction SilentlyContinue
}

function Get-RouterState {
  $port = Get-Port
  $alive = Test-RouterAlive -Port $port -TimeoutSec 5
  return [PSCustomObject]@{
    Port       = $port
    Supervisor = Read-LivePid -Path $PidFile
    Child      = Read-LivePid -Path $ChildPidFile
    Alive      = $alive
  }
}

# --- Health: the only function that probes the endpoint. ---
function Test-RouterAlive {
  param([int]$Port, [int]$TimeoutSec = 5)
  try {
    $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/ping" -TimeoutSec $TimeoutSec -UseBasicParsing
    return $resp.StatusCode -eq 200
  } catch { return $false }
}

function Write-Status {
  $state = Get-RouterState

  Write-Host ''
  Write-Host "  port      : $($state.Port)"
  Write-Host "  supervisor: $(if ($state.Supervisor) { "running (pid $($state.Supervisor))" } else { 'not running' })"
  Write-Host "  server    : $(if ($state.Child) { "running (pid $($state.Child))" } else { 'not running' })"
  Write-Host "  endpoint  : $(if ($state.Alive) { 'RESPONDING' } else { 'NOT responding' })"
  Write-Host "  log       : $OutLog"
  Write-Host ''
}

function Stop-Router {
  $state = Get-RouterState

  # Kill the supervised server first, then the supervisor. The other order lets
  # a live supervisor notice a dead child and restart it a moment later.
  if ($state.Child) {
    Write-Host "Stopping server (pid $($state.Child))..."
    Stop-Process -Id $state.Child -Force -ErrorAction SilentlyContinue
  }
  if ($state.Supervisor) {
    Write-Host "Stopping supervisor (pid $($state.Supervisor))..."
    Stop-Process -Id $state.Supervisor -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 1
  Clear-PidFiles
  if (-not $state.Child -and -not $state.Supervisor) { Write-Host 'Nothing was running.' }
}

function Start-Supervisor {
  # Detached, windowless, and independent of the shell that asked for it. This
  # is the whole point of the script: the parent process going away must not
  # take the router with it.
  $args = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-WindowStyle', 'Hidden',
    '-File', (Join-Path $PSScriptRoot 'router-service.ps1'),
    'foreground'
  )
  $p = Start-Process -FilePath 'powershell' -ArgumentList $args -WindowStyle Hidden -PassThru
  Write-PidFile -Path $PidFile -ProcId $p.Id
  Write-Host "Supervisor started (pid $($p.Id))."
}

function Wait-Ready {
  $port = Get-Port
  for ($i = 0; $i -lt 40; $i++) {
    if (Test-RouterAlive -Port $port -TimeoutSec 3) {
      Write-Host "Router is up on http://127.0.0.1:$port"
      return $true
    }
    Start-Sleep -Milliseconds 500
  }
  Write-Host "Router did not answer on port $port within 20s - check $ErrLog"
  return $false
}

function Run-Foreground {
  if (-not (Test-Path $Entry)) {
    throw "Built server not found at $Entry. Run: npm run build -w server"
  }
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  $port = Get-Port
  $delay = 2

  while ($true) {
    Write-Host "[router-service] starting node $Entry (port $port)"
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    Add-Content -Path $OutLog -Value "[$stamp] [router-service] starting on port $port"
    $env:NODE_ENV = 'production'
    $env:PORT = "$port"

    $child = Start-Process -FilePath 'node' `
      -ArgumentList $Entry `
      -WorkingDirectory $RepoRoot `
      -RedirectStandardOutput $OutLog `
      -RedirectStandardError $ErrLog `
      -NoNewWindow -PassThru
    Write-PidFile -Path $ChildPidFile -ProcId $child.Id

    $child.WaitForExit()
    $code = $child.ExitCode
    Remove-Item $ChildPidFile -ErrorAction SilentlyContinue
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    Add-Content -Path $OutLog -Value "[$stamp] [router-service] exited with code $code; restarting in ${delay}s"

    # Backoff so a permanently broken config (port taken, bad .env) doesn't
    # spin the CPU in a tight restart loop.
    Start-Sleep -Seconds $delay
    $delay = [Math]::Min($delay * 2, 60)
  }
}

switch ($Action) {
  'status' { Write-Status }
  'autostart-install' {
    $path = Get-AutostartPath
    $launcher = Join-Path $PSScriptRoot 'router-service.ps1'
    $lines = @(
      '@echo off',
      'rem Starts the FreeLLMAPI router at logon. Managed by router-service.ps1',
      'rem (autostart-install / autostart-remove); edit that script, not this file.',
      "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`" start"
    )
    Set-Content -Path $path -Value $lines -Encoding ascii
    Write-Host "Autostart installed: $path"
  }
  'autostart-remove' {
    $path = Get-AutostartPath
    if (Test-Path $path) { Remove-Item $path -Force; Write-Host "Autostart removed: $path" }
    else { Write-Host "No autostart entry at $path" }
  }
  'stop' { Stop-Router; Write-Status }
  'restart' { Stop-Router; Start-Supervisor; Wait-Ready | Out-Null; Write-Status }
  'start' {
    if (Read-LivePid -Path $PidFile) {
      Write-Host 'Router supervisor is already running.'
      Write-Status
      break
    }
    Clear-PidFiles
    Start-Supervisor
    Wait-Ready | Out-Null
    Write-Status
  }
  'foreground' { Run-Foreground }
}
