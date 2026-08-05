# dev-bootstrap.ps1 — bootstrap a FreeLLMAPI contributor checkout on Windows.
#
# Idempotent one-shot setup mirroring scripts/dev-bootstrap.sh so both
# platforms stay in lockstep (issue #434).
#
#   1. Verifies Node meets the engines range (>=20.18.0 <25.0.0).
#   2. Runs `npm install` when node_modules is missing or package-lock.json
#      changed since the last install.
#   3. Creates .env from .env.example with a fresh ENCRYPTION_KEY when .env
#      is missing (never touches an existing .env).
#   4. Prints the next step. It does NOT auto-launch `npm run dev`.

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Log($msg) { Write-Host "[dev-bootstrap] $msg" }

# --- 1. Node version check -----------------------------------------------
$nodeRaw = & node --version 2>$null
if (-not $nodeRaw) {
    Write-Host "[dev-bootstrap] Node.js not found on PATH. Install Node 20.18+ (https://nodejs.org) and re-run." -ForegroundColor Red
    exit 1
}
$nodeVer = $nodeRaw -replace '^v', ''
$parts = $nodeVer -split '\.'
$major = [int]$parts[0]
$minor = [int]$parts[1]
if ($major -lt 20 -or ($major -eq 20 -and $minor -lt 18) -or $major -ge 25) {
    Write-Host "[dev-bootstrap] Node $nodeVer is outside the supported range (>=20.18.0 <25.0.0)." -ForegroundColor Red
    exit 1
}
Log "Node $nodeVer OK"

# --- 2. npm install when needed ------------------------------------------
$needInstall = $false
if (-not (Test-Path node_modules)) {
    $needInstall = $true
}
elseif (-not (Test-Path node_modules/.package-lock.json)) {
    $needInstall = $true
}
elseif ((Get-Item package-lock.json -ErrorAction SilentlyContinue).LastWriteTime -gt (Get-Item node_modules/.package-lock.json).LastWriteTime) {
    $needInstall = $true
}
if ($needInstall) {
    Log 'Installing dependencies (npm install)…'
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[dev-bootstrap] npm install failed." -ForegroundColor Red
        exit 1
    }
}
else {
    Log 'node_modules is up to date — skipping npm install'
}

# --- 3. .env from .env.example -------------------------------------------
if (-not (Test-Path .env)) {
    if (-not (Test-Path .env.example)) {
        Write-Host '[dev-bootstrap] .env.example is missing — is the clone complete?' -ForegroundColor Red
        exit 1
    }
    $key = (& node -e "console.log(require('crypto').randomBytes(32).toString('hex'))").Trim()
    Copy-Item .env.example .env
    $envContent = Get-Content .env -Raw
    if ($envContent -match '^ENCRYPTION_KEY=.*') {
        $envContent = $envContent -replace '^ENCRYPTION_KEY=.*', "ENCRYPTION_KEY=$key"
    }
    else {
        $envContent += "`r`nENCRYPTION_KEY=$key"
    }
    Set-Content .env -Value $envContent -NoNewline
    Log '.env created from .env.example with a fresh ENCRYPTION_KEY'
}
else {
    Log '.env already exists — left untouched'
}

# --- 4. Done -------------------------------------------------------------
Log 'Bootstrap complete. Run `npm run dev` to start the development server.'
Write-Host ""
Write-Host "  cd $(Split-Path -Leaf $Root)"
Write-Host "  npm run dev"
Write-Host ""