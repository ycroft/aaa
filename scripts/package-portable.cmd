@echo off
rem Wrapper so colleagues can double-click without dealing with execution policy.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0package-portable.ps1" %*
exit /b %ERRORLEVEL%
