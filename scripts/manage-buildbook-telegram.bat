@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0manage-buildbook-telegram.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%EXIT_CODE%"=="0" echo Управление завершилось с ошибкой. Проверьте сообщение выше.
pause
exit /b %EXIT_CODE%
