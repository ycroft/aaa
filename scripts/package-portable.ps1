# Pack a portable zip: aaa.exe + icon + a self-contained installer.
#
# Output:  dist-pkg\aaa-<version>-windows-<arch>.zip
#
# Recipient workflow:
#   1. Extract the zip.
#   2. Double-click install.cmd  (or run .\install.ps1).
#      Uninstall: install.cmd --uninstall
#
# Recipient does NOT need Visual C++ runtime, WebView2 ships with Windows 11
# and current Windows 10. On older / stripped images they may need to install
# the Microsoft Edge WebView2 Evergreen runtime once.

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$BinName = 'aaa.exe'
$AppId   = 'dev.aaa.analyzer'
$AppName = 'AAA'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Resolve-Path (Join-Path $scriptDir '..')
Set-Location $rootDir

# Pull version from src-tauri\Cargo.toml — single source of truth.
$cargoToml = Get-Content -LiteralPath 'src-tauri\Cargo.toml' -Raw
$verMatch = [regex]::Match($cargoToml, '(?m)^version\s*=\s*"([^"]+)"')
if (-not $verMatch.Success) {
    Write-Error 'Could not read version from src-tauri\Cargo.toml'
    exit 1
}
$version = $verMatch.Groups[1].Value

$arch = switch ($env:PROCESSOR_ARCHITECTURE) {
    'AMD64' { 'x86_64' }
    'ARM64' { 'aarch64' }
    'x86'   { 'i686' }
    default { $env:PROCESSOR_ARCHITECTURE.ToLower() }
}

$srcBin = @(
    "target\release\$BinName",
    "src-tauri\target\release\$BinName"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $srcBin) {
    Write-Error "Release binary not found. Run .\scripts\build-release.ps1 first."
    exit 1
}

$srcIcon = @(
    'src-tauri\icons\icon.ico',
    'src-tauri\icons\icon.png'
) | Where-Object { Test-Path $_ } | Select-Object -First 1

$stageName = "aaa-$version-windows-$arch"
$stageRoot = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
$stageDir = Join-Path $stageRoot $stageName
New-Item -ItemType Directory -Force -Path (Join-Path $stageDir 'bin') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $stageDir 'icons') | Out-Null

Copy-Item -LiteralPath $srcBin -Destination (Join-Path $stageDir "bin\$BinName") -Force
# Tauri 2 emits WebView2Loader.dll next to aaa.exe — ship the whole runtime
# directory (any .dll) so the recipient's install isn't missing dependencies.
$srcBinDir = Split-Path -Parent $srcBin
Get-ChildItem -LiteralPath $srcBinDir -Filter '*.dll' -File |
    ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $stageDir 'bin') -Force }
if ($srcIcon) {
    $iconLeaf = Split-Path -Leaf $srcIcon
    Copy-Item -LiteralPath $srcIcon -Destination (Join-Path $stageDir "icons\$iconLeaf") -Force
}
if (Test-Path 'README.md') {
    Copy-Item -LiteralPath 'README.md' -Destination (Join-Path $stageDir 'README.md') -Force
}

# Self-contained installer that the recipient runs.
$installPs1 = @'
# Installer baked into the AAA portable zip.
# Per-user install (no admin):  .\install.ps1
# Uninstall:                    .\install.ps1 -Uninstall

[CmdletBinding()]
param(
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$AppName = 'AAA'
$BinName = 'aaa.exe'
$ShortcutName = "$AppName · Agent Analyzer.lnk"

# Show · and other non-ASCII glyphs correctly even when the host codepage is GBK/CP932/etc.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$installRoot = Join-Path $env:LOCALAPPDATA 'Programs\AAA'
$installBin  = Join-Path $installRoot $BinName
$startMenuDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$shortcutPath = Join-Path $startMenuDir $ShortcutName

function Update-UserPath {
    param([string]$Add, [string]$Remove)
    $current = [Environment]::GetEnvironmentVariable('Path', 'User')
    $entries = @()
    if ($current) { $entries = $current -split ';' | Where-Object { $_ -ne '' } }
    if ($Remove) { $entries = $entries | Where-Object { $_ -ne $Remove } }
    if ($Add -and ($entries -notcontains $Add)) { $entries += $Add }
    [Environment]::SetEnvironmentVariable('Path', ($entries -join ';'), 'User')
}

if ($Uninstall) {
    Write-Host "Removing $AppName from $installRoot"
    if (Test-Path $shortcutPath) { Remove-Item -LiteralPath $shortcutPath -Force }
    if (Test-Path $installRoot)  { Remove-Item -LiteralPath $installRoot -Recurse -Force }
    Update-UserPath -Remove $installRoot
    Write-Host 'Done. Open a new shell to refresh PATH.'
    exit 0
}

New-Item -ItemType Directory -Force -Path $installRoot | Out-Null
# -Path (not -LiteralPath) so the bin\* wildcard expands to all binaries + DLLs.
Copy-Item -Path (Join-Path $here 'bin\*') -Destination $installRoot -Recurse -Force

$installedIcon = $null
$icoSrc = Join-Path $here 'icons\icon.ico'
$pngSrc = Join-Path $here 'icons\icon.png'
if (Test-Path $icoSrc) {
    $installedIcon = Join-Path $installRoot 'icon.ico'
    Copy-Item -LiteralPath $icoSrc -Destination $installedIcon -Force
} elseif (Test-Path $pngSrc) {
    $installedIcon = Join-Path $installRoot 'icon.png'
    Copy-Item -LiteralPath $pngSrc -Destination $installedIcon -Force
}

New-Item -ItemType Directory -Force -Path $startMenuDir | Out-Null
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $installBin
$shortcut.WorkingDirectory = $installRoot
$shortcut.Description = 'Inspect local AI coding agent session logs'
if ($installedIcon -and $installedIcon.ToLower().EndsWith('.ico')) {
    $shortcut.IconLocation = $installedIcon
} else {
    $shortcut.IconLocation = "$installBin,0"
}
$shortcut.Save()

Update-UserPath -Add $installRoot

Write-Host "Installed $AppName to $installRoot"
Write-Host "  Run from a new terminal:    aaa"
Write-Host "  Or find '$AppName · Agent Analyzer' in the Start Menu."
'@

Set-Content -LiteralPath (Join-Path $stageDir 'install.ps1') -Value $installPs1 -Encoding UTF8
# PS 7 Set-Content -Encoding UTF8 omits the BOM, but recipients on Windows
# PowerShell 5.1 with a non-UTF8 ANSI codepage (e.g. zh-CN GBK) need the BOM
# to read the script as UTF-8 — without it the · in the shortcut name gets
# mangled and CreateShortcut() ends up writing a broken .lnk.
$utf8Bom = New-Object System.Text.UTF8Encoding($true)
$installPs1Path = Join-Path $stageDir 'install.ps1'
[System.IO.File]::WriteAllText($installPs1Path, [System.IO.File]::ReadAllText($installPs1Path, [System.Text.Encoding]::UTF8), $utf8Bom)

$installCmd = @'
@echo off
rem Wrapper so the recipient can double-click without dealing with execution policy.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
exit /b %ERRORLEVEL%
'@
Set-Content -LiteralPath (Join-Path $stageDir 'install.cmd') -Value $installCmd -Encoding ASCII

New-Item -ItemType Directory -Force -Path 'dist-pkg' | Out-Null
$out = "dist-pkg\$stageName.zip"
if (Test-Path $out) { Remove-Item -LiteralPath $out -Force }
Compress-Archive -Path (Join-Path $stageDir '*') -DestinationPath $out -CompressionLevel Optimal

Remove-Item -LiteralPath $stageRoot -Recurse -Force

$size = '{0:N1} MB' -f ((Get-Item -LiteralPath $out).Length / 1MB)
Write-Host "Packed: $out  ($size)"
Write-Host ''
Write-Host 'Recipient command:'
Write-Host "  Expand-Archive $stageName.zip; cd $stageName; .\install.cmd"
