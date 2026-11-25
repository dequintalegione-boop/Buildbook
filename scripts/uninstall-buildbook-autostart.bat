@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall-buildbook-autostart.ps1"
if errorlevel 1 (
  echo.
  echo Не удалось удалить автозапуск. Проверьте сообщение выше.
  pause
  exit /b 1
)
echo.
pause
