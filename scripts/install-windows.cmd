@echo off
rem Wrapper so colleagues can double-click without dealing with execution policy.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-windows.ps1" %*
exit /b %ERRORLEVEL%
