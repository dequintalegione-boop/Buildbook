@echo off
setlocal
cd /d "%~dp0.."
echo Buildbook — запуск локального хоста
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 LTS или новее не найден. Установите Node.js и повторите запуск.
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-buildbook-local-host.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%EXIT_CODE%"=="0" echo Локальный хост завершился с ошибкой. Проверьте сообщение выше и data\local-host.log.
pause
exit /b %EXIT_CODE%
