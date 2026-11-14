# Windows packaging smoke test for #1759 (GPU process dies in its LPAC sandbox).
#
#   1. Reproduce the reporter's machine: copy the unpacked app into a folder
#      whose ACL has no S-1-15-2-2 grant and carries an orphaned S-1-15-...
#      SID (electron/electron#51761), launch it, and require the app to be up
#      and serving within the timeout (the runtime recovery in
#      src/gpu-recovery.ts relaunches it if the GPU process dies).
#   2. Install the NSIS installer silently and require the install folder ACL
#      to grant ALL RESTRICTED APPLICATION PACKAGES (installer/installer.nsh),
#      then launch the installed app the same way.
#
# Usage: pwsh desktop/scripts/smoke-win-gpu-sandbox.ps1 <dist-electron dir>
param([Parameter(Mandatory = $true)][string]$Dist)

$ErrorActionPreference = 'Stop'
$Dist = (Resolve-Path $Dist).Path
$userData = Join-Path $env:APPDATA 'FreeLLMAPI'
$log = Join-Path $userData 'logs\freeapi.log'
$config = Join-Path $userData 'config.json'
$restrictedSid = 'S-1-15-2-2'
# Shaped like a capability SID whose package no longer exists.
$zombieSid = 'S-1-15-3-1024-1065365936-1281604716-3511738428-1654721687-432734479-3232135806-4053264122-3456934681'

function Stop-App {
  Get-Process -Name 'FreeLLMAPI' -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 2
}

function Reset-UserData {
  Stop-App
  if (Test-Path $userData) { Remove-Item -Recurse -Force $userData }
}

function Test-Up {
  try {
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri 'http://127.0.0.1:31415/' | Out-Null
    return $true
  } catch {
    # Any HTTP answer (401 included) means the embedded server is listening.
    return $null -ne $_.Exception.Response
  }
}

function Assert-Launches([string]$exe, [string]$label) {
  Write-Host "== ${label}: launching $exe"
  Start-Process -FilePath $exe | Out-Null
  $deadline = (Get-Date).AddSeconds(120)
  $up = $false
  while ((Get-Date) -lt $deadline) {
    if (Test-Up) { $up = $true; break }
    Start-Sleep -Seconds 2
  }
  # Stay up a while longer: the reported crash lands a few seconds after the
  # server has started listening.
  if ($up) { Start-Sleep -Seconds 20; $up = (Test-Up) -and (Get-Process -Name 'FreeLLMAPI' -ErrorAction SilentlyContinue) }

  Write-Host "-- log ($label):"
  if (Test-Path $log) { Get-Content $log | Select-String -Pattern 'gpu|GPU|running on' | ForEach-Object { Write-Host "   $_" } }
  if (Test-Path $config) { Write-Host "-- config.json: $(Get-Content -Raw $config)" }
  if ($log -and (Test-Path $log) -and (Select-String -Path $log -Pattern 'GPU process gone' -Quiet)) {
    Write-Host "::notice::$label reproduced the GPU sandbox crash and recovered from it"
  } else {
    Write-Host "::notice::$label did not hit a GPU crash on this runner"
  }
  Stop-App
  if (-not $up) { throw "${label}: FreeLLMAPI was not up and serving on 127.0.0.1:31415" }
  Write-Host "== ${label}: OK"
}

# 1. Broken ACL repro on the unpacked app.
$unpacked = Join-Path $Dist 'win-unpacked'
$broken = Join-Path $env:RUNNER_TEMP 'gpu-acl-repro\FreeLLMAPI'
if (Test-Path $broken) { Remove-Item -Recurse -Force $broken }
New-Item -ItemType Directory -Force -Path (Split-Path $broken) | Out-Null
Copy-Item -Recurse $unpacked $broken
& icacls $broken /remove:g "*$restrictedSid" /T /C /Q | Out-Null
& icacls $broken /grant "*${zombieSid}:(OI)(CI)(RX)" /T /C /Q
if ($LASTEXITCODE -ne 0) { throw 'could not add the orphaned SID to the repro folder' }
Write-Host '-- repro folder ACL:'; & icacls $broken

Reset-UserData
Assert-Launches (Join-Path $broken 'FreeLLMAPI.exe') 'broken-ACL portable copy'

# 2. NSIS install grants the SID.
$setup = Get-ChildItem -Path $Dist -Filter 'FreeLLMAPI-Setup-*.exe' | Select-Object -First 1
if (-not $setup) { throw "no FreeLLMAPI-Setup-*.exe in $Dist" }
Write-Host "== installing $($setup.Name) silently"
$p = Start-Process -FilePath $setup.FullName -ArgumentList '/S' -Wait -PassThru
if ($p.ExitCode -ne 0) { throw "installer exited $($p.ExitCode)" }
Stop-App  # a one-click install may start the app when it finishes

$exe = Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'Programs') -Recurse -Filter 'FreeLLMAPI.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $exe) { throw 'FreeLLMAPI.exe not found under %LOCALAPPDATA%\Programs after install' }
$installDir = $exe.DirectoryName
Write-Host "-- install folder ACL ($installDir):"
$acl = & icacls $installDir
$acl | ForEach-Object { Write-Host "   $_" }
if (-not ($acl -match 'ALL RESTRICTED APPLICATION PACKAGES')) {
  throw 'installer did not grant ALL RESTRICTED APPLICATION PACKAGES (S-1-15-2-2) on the install folder'
}

Reset-UserData
Assert-Launches $exe.FullName 'installed app'
