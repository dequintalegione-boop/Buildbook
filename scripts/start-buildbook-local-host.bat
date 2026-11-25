@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-buildbook-local-host.ps1"
set "HOST_EXIT=%ERRORLEVEL%"
echo.
if not "%HOST_EXIT%"=="0" (
  echo Локальный хост завершился с ошибкой. Проверьте сообщение выше и файл data\local-host.log.
) else (
  echo Локальный хост остановлен.
)
echo.
pause
exit /b %HOST_EXIT%
