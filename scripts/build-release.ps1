# Release build for AAA on Windows.
#
# Usage:  .\scripts\build-release.ps1 [-NoBundle] [-Target <triple>]
#
#   (default)     Build the Tauri bundles tauri.conf.json declares
#                 (on Windows: MSI + NSIS .exe + bare aaa.exe).
#   -NoBundle     Skip installer bundling, only produce target\release\aaa.exe.
#   -Target       Cross-target triple, forwarded as `tauri build --target ...`.
#
# Offline-friendly: before invoking tauri-bundler the script primes
# %LOCALAPPDATA%\tauri\ from vendor\tauri-cache-windows\ so MSI/NSIS bundling
# does not need internet access. See vendor\tauri-cache-windows\README.md for
# how to populate that directory.

[CmdletBinding()]
param(
    [switch]$NoBundle,
    [string]$Target
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Resolve-Path (Join-Path $scriptDir '..')
Set-Location $rootDir

# Tauri 2 requires Node >= 20.19 (Vite 8). Fail fast with a clear hint.
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "'node' not found in PATH. Install Node >= 20.19."
    exit 1
}
$nodeVer = (& node -p 'process.versions.node').Trim()
$parts = $nodeVer.Split('.')
$nodeMajor = [int]$parts[0]
$nodeMinor = [int]$parts[1]
if ($nodeMajor -lt 20 -or ($nodeMajor -eq 20 -and $nodeMinor -lt 19)) {
    Write-Error "Node $nodeVer is too old; Vite 8 needs >= 20.19."
    exit 1
}

if (-not (Test-Path 'node_modules')) {
    Write-Host '>> npm install'
    & npm install
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

# Prime %LOCALAPPDATA%\tauri\ with vendored WiX/NSIS assets so tauri-bundler
# skips its GitHub downloads (which routinely time out from CN/intranet hosts).
# Files live in vendor\tauri-cache-windows\ — see that README for sourcing.
$vendorDir = Join-Path $rootDir 'vendor\tauri-cache-windows'
$tauriCache = Join-Path $env:LOCALAPPDATA 'tauri'

function Prime-WixTools {
    param([string]$zipPath, [string]$cacheRoot)
    $wixDir = Join-Path $cacheRoot 'WixTools314'
    if (Test-Path (Join-Path $wixDir 'candle.exe')) {
        Write-Host "  WiX cache already populated: $wixDir"
        return
    }
    if (-not (Test-Path $zipPath)) {
        Write-Host "  WiX vendor missing: $zipPath (skipping; bundler will try GitHub)"
        return
    }
    Write-Host "  priming WiX -> $wixDir"
    New-Item -ItemType Directory -Force -Path $wixDir | Out-Null
    Expand-Archive -LiteralPath $zipPath -DestinationPath $wixDir -Force
}

function Prime-Nsis {
    param([string]$zipPath, [string]$dllPath, [string]$cacheRoot)
    $nsisDir = Join-Path $cacheRoot 'NSIS'
    $pluginPath = Join-Path $nsisDir 'Plugins\x86-unicode\additional\nsis_tauri_utils.dll'
    $haveMakensis = Test-Path (Join-Path $nsisDir 'makensis.exe')
    $havePlugin = Test-Path $pluginPath

    if ($haveMakensis -and $havePlugin) {
        Write-Host "  NSIS cache already populated: $nsisDir"
        return
    }

    if (-not $haveMakensis) {
        if (-not (Test-Path $zipPath)) {
            Write-Host "  NSIS vendor missing: $zipPath (skipping; bundler will try GitHub)"
        } else {
            Write-Host "  priming NSIS -> $nsisDir"
            $tmp = New-Item -ItemType Directory -Force -Path (Join-Path $env:TEMP "aaa-nsis-$([guid]::NewGuid())")
            try {
                Expand-Archive -LiteralPath $zipPath -DestinationPath $tmp.FullName -Force
                # The archive's top-level directory is "nsis-3.11\".
                $top = Get-ChildItem -LiteralPath $tmp.FullName -Directory |
                       Where-Object { $_.Name -like 'nsis-*' } |
                       Select-Object -First 1
                if ($null -eq $top) { throw "unexpected NSIS archive layout under $($tmp.FullName)" }
                if (Test-Path $nsisDir) { Remove-Item -LiteralPath $nsisDir -Recurse -Force }
                Move-Item -LiteralPath $top.FullName -Destination $nsisDir
            } finally {
                Remove-Item -LiteralPath $tmp.FullName -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
    }

    if (-not (Test-Path $pluginPath)) {
        if (-not (Test-Path $dllPath)) {
            Write-Host "  nsis_tauri_utils.dll vendor missing: $dllPath (skipping; bundler will try GitHub)"
        } else {
            $pluginDir = Split-Path -Parent $pluginPath
            New-Item -ItemType Directory -Force -Path $pluginDir | Out-Null
            Copy-Item -LiteralPath $dllPath -Destination $pluginPath -Force
            Write-Host "  staged nsis_tauri_utils.dll -> $pluginPath"
        }
    }
}

if (-not $NoBundle) {
    Write-Host '>> priming %LOCALAPPDATA%\tauri\ from vendor\tauri-cache-windows\'
    if (-not (Test-Path $tauriCache)) { New-Item -ItemType Directory -Force -Path $tauriCache | Out-Null }
    Prime-WixTools -zipPath (Join-Path $vendorDir 'wix314-binaries.zip') -cacheRoot $tauriCache
    Prime-Nsis     -zipPath (Join-Path $vendorDir 'nsis-3.11.zip') `
                   -dllPath (Join-Path $vendorDir 'nsis_tauri_utils.dll') `
                   -cacheRoot $tauriCache
}

$cliArgs = @()
if ($NoBundle) { $cliArgs += '--no-bundle' }
if ($Target)   { $cliArgs += @('--target', $Target) }

Write-Host (">> tauri build " + ($cliArgs -join ' '))
& npx tauri build @cliArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$outDir = if ($Target) { "target\$Target\release" } else { 'target\release' }
Write-Host ''
Write-Host 'Build artefacts:'
$binPath = Join-Path $outDir 'aaa.exe'
if (Test-Path $binPath) { Write-Host "  binary : $binPath" }
$bundleDir = Join-Path $outDir 'bundle'
if (-not $NoBundle -and (Test-Path $bundleDir)) {
    Get-ChildItem -LiteralPath $bundleDir -Recurse -File |
        Where-Object { $_.Extension -in '.msi', '.exe', '.zip' } |
        ForEach-Object { Write-Host "  bundle : $($_.FullName)" }
}
