[CmdletBinding()]
param(
    [string]$ProjectRoot
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $ScriptDirectory = Split-Path -Parent $PSCommandPath
    $ProjectRoot = Split-Path -Parent $ScriptDirectory
}

function Get-CommandVersion {
    param(
        [string]$Command,
        [string]$Argument
    )

    $version = (& $Command $Argument).Trim().TrimStart('v')
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($version)) {
        throw "Unable to determine $Command version."
    }

    return [Version]$version
}

function Get-LockHash {
    param([string]$Path)

    # .NET directly rather than Get-FileHash: Windows PowerShell 5.1 started
    # from a PowerShell 7 shell inherits PS7's PSModulePath and cannot load its
    # own Microsoft.PowerShell.Utility, so Get-FileHash is "not recognized" (#1392).
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = $sha256.ComputeHash([System.IO.File]::ReadAllBytes($Path))
    } finally {
        $sha256.Dispose()
    }
    return ([System.BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant()
}

$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$packageJson = Join-Path $ProjectRoot 'package.json'
$lockfile = Join-Path $ProjectRoot 'package-lock.json'
$nodeModules = Join-Path $ProjectRoot 'node_modules'
$lockStamp = Join-Path $nodeModules '.freellmapi-bootstrap-lock'
$envFile = Join-Path $ProjectRoot '.env'

if (-not (Test-Path -LiteralPath $packageJson) -or -not (Test-Path -LiteralPath $lockfile)) {
    throw "Project root must contain package.json and package-lock.json: $ProjectRoot"
}

$nodeVersion = Get-CommandVersion -Command 'node' -Argument '--version'
if ($nodeVersion -lt [Version]'20.18.0' -or $nodeVersion -ge [Version]'25.0.0') {
    throw "Node.js >=20.18.0 and <25.0.0 is required; found $nodeVersion."
}

$npmVersion = Get-CommandVersion -Command 'npm' -Argument '--version'
if ($npmVersion -lt [Version]'10.0.0') {
    throw "npm >=10.0.0 is required; found $npmVersion."
}

$lockHash = Get-LockHash -Path $lockfile
$installedLockHash = if (Test-Path -LiteralPath $lockStamp) {
    (Get-Content -LiteralPath $lockStamp -Raw).Trim().ToLowerInvariant()
} else {
    ''
}

Push-Location $ProjectRoot
try {
    if (-not (Test-Path -LiteralPath $nodeModules) -or $installedLockHash -ne $lockHash) {
        Write-Host 'Installing dependencies...'
        & npm install
        if ($LASTEXITCODE -ne 0) {
            throw "npm install failed with exit code $LASTEXITCODE."
        }

        $lockHash = Get-LockHash -Path $lockfile
        Set-Content -LiteralPath $lockStamp -Value $lockHash -NoNewline -Encoding ascii
    } else {
        Write-Host 'Dependencies already match package-lock.json.'
    }

    if (-not (Test-Path -LiteralPath $envFile)) {
        $encryptionKey = (& node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))").Trim()
        if ($LASTEXITCODE -ne 0 -or $encryptionKey -notmatch '^[0-9a-f]{64}$') {
            throw 'Unable to generate ENCRYPTION_KEY.'
        }

        @(
            "ENCRYPTION_KEY=$encryptionKey"
            'PORT=3001'
        ) | Set-Content -LiteralPath $envFile -Encoding ascii
        Write-Host 'Created .env with a new ENCRYPTION_KEY.'
    } else {
        Write-Host '.env already exists; leaving it unchanged.'
    }
} finally {
    Pop-Location
}

Write-Host 'Bootstrap complete. Start development with: npm run dev'
