@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-buildbook-telegram.ps1"
set "SETUP_EXIT=%ERRORLEVEL%"
echo.
if not "%SETUP_EXIT%"=="0" (
  echo Настройка завершилась с ошибкой. Проверьте сообщение выше.
) else (
  echo Настройка завершена. Telegram polling оставлен выключенным.
)
echo.
pause
exit /b %SETUP_EXIT%
