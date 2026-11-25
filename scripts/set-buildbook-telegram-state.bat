@echo off
setlocal
echo Управление Telegram в локальном хосте Buildbook
echo.
echo 1 - Включить Telegram (требуется подтверждение канонического профиля)
echo 2 - Выключить Telegram
echo.
choice /C 12 /N /M "Выберите действие (1/2): "
if errorlevel 2 set "MODE=disable"
if errorlevel 1 if not defined MODE set "MODE=enable"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0set-buildbook-telegram-state.ps1" -Mode %MODE%
if errorlevel 1 (
  echo.
  echo Операция не выполнена. Проверьте сообщение выше.
  pause
  exit /b 1
)
echo.
pause
