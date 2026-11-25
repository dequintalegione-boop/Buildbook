@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-buildbook-telegram.ps1"
if errorlevel 1 pause
