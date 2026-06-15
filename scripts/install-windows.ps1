# User-level install/uninstall for AAA on Windows.
#
# Lays the binary down under %LOCALAPPDATA%\Programs\AAA, creates a Start Menu
# shortcut, and adds the install dir to the user PATH (so `aaa` works from
# any new shell). No admin rights needed.
#
# Usage:
#   .\scripts\install-windows.ps1                 # install for current user
#   .\scripts\install-windows.ps1 -Uninstall      # remove what we put there
#
# Source binary search order (first match wins):
#   target\release\aaa.exe
#   src-tauri\target\release\aaa.exe
#   $env:CARGO_TARGET_DIR\release\aaa.exe
#
# If you want to install from a portable zip you've already extracted, use
# the install.ps1 baked into that zip (produced by package-portable.ps1).

[CmdletBinding()]
param(
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

# Show · and other non-ASCII glyphs correctly even when the host codepage is GBK/CP932/etc.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$AppId   = 'dev.aaa.analyzer'
$AppName = 'AAA'
$BinName = 'aaa.exe'
$ShortcutName = "$AppName · Agent Analyzer.lnk"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Resolve-Path (Join-Path $scriptDir '..')

$installRoot = Join-Path $env:LOCALAPPDATA 'Programs\AAA'
$installBin  = Join-Path $installRoot $BinName
$startMenuDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$shortcutPath = Join-Path $startMenuDir $ShortcutName

function Update-UserPath {
    param([string]$Add, [string]$Remove)
    $current = [Environment]::GetEnvironmentVariable('Path', 'User')
    $entries = @()
    if ($current) {
        $entries = $current -split ';' | Where-Object { $_ -ne '' }
    }
    if ($Remove) {
        $entries = $entries | Where-Object { $_ -ne $Remove }
    }
    if ($Add -and ($entries -notcontains $Add)) {
        $entries += $Add
    }
    $newPath = ($entries -join ';')
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
}

if ($Uninstall) {
    Write-Host "Removing $AppName from $installRoot"
    if (Test-Path $shortcutPath) { Remove-Item -LiteralPath $shortcutPath -Force }
    if (Test-Path $installRoot)  { Remove-Item -LiteralPath $installRoot -Recurse -Force }
    Update-UserPath -Remove $installRoot
    Write-Host 'Done. Open a new shell to refresh PATH.'
    exit 0
}

# Find the release binary.
$candidates = @(
    (Join-Path $rootDir "target\release\$BinName"),
    (Join-Path $rootDir "src-tauri\target\release\$BinName")
)
if ($env:CARGO_TARGET_DIR) {
    $candidates += (Join-Path $env:CARGO_TARGET_DIR "release\$BinName")
}
$srcBin = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $srcBin) {
    Write-Error "Release binary not found. Run .\scripts\build-release.ps1 first."
    exit 1
}

# Find an icon for the shortcut.
$srcIcon = @(
    (Join-Path $rootDir 'src-tauri\icons\icon.ico'),
    (Join-Path $rootDir 'src-tauri\icons\icon.png')
) | Where-Object { Test-Path $_ } | Select-Object -First 1

Write-Host "Installing $AppName to $installRoot"
New-Item -ItemType Directory -Force -Path $installRoot | Out-Null
Copy-Item -LiteralPath $srcBin -Destination $installBin -Force
# Tauri 2 emits WebView2Loader.dll next to the exe — without it the app
# fails to start with "找不到 WebView2Loader.dll".
$srcDir = Split-Path -Parent $srcBin
Get-ChildItem -LiteralPath $srcDir -Filter '*.dll' -File |
    ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $installRoot -Force }
$installedIcon = $null
if ($srcIcon) {
    $iconLeaf = Split-Path -Leaf $srcIcon
    $installedIcon = Join-Path $installRoot $iconLeaf
    Copy-Item -LiteralPath $srcIcon -Destination $installedIcon -Force
}

# Start Menu shortcut.
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

Write-Host 'Installed:'
Write-Host "  binary   : $installBin"
Write-Host "  shortcut : $shortcutPath"
Write-Host ''
Write-Host "Run from a new terminal:    aaa"
Write-Host "Or find '$AppName · Agent Analyzer' in the Start Menu."
