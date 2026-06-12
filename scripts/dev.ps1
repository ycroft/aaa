# Local dev run for AAA on Windows.
#
# Usage:  .\scripts\dev.ps1 [extra args forwarded to `tauri dev`]

$ErrorActionPreference = 'Stop'

$rootDir = Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..')
Set-Location $rootDir

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "'node' not found in PATH. Install Node >= 20.19."
    exit 1
}
$nodeVer = (node -v) -replace '^v',''
$nodeParts = $nodeVer.Split('.')
if ([int]$nodeParts[0] -lt 20 -or ([int]$nodeParts[0] -eq 20 -and [int]$nodeParts[1] -lt 19)) {
    Write-Error "Node v$nodeVer is too old; Vite 8 needs >= 20.19."
    exit 1
}

if (-not (Test-Path node_modules)) {
    Write-Host ">> npm install"
    npm install
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Write-Host ">> tauri dev $args"
npx tauri dev @args
exit $LASTEXITCODE
