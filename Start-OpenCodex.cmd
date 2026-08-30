@echo off
setlocal

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-OpenCodex.ps1" %*
set "launcher_exit=%ERRORLEVEL%"

if not "%launcher_exit%"=="0" (
  echo.
  echo OpenCodex could not be started. Review the error above.
  pause
)

exit /b %launcher_exit%
