if exist "%OCX_API_TOKEN_FILE%" (
  set /p OPENCODEX_API_AUTH_TOKEN=<"%OCX_API_TOKEN_FILE%"
)
:loop
>>"%OCX_SERVICE_LOG%" echo [%DATE% %TIME%] opencodex service wrapper start
>>"%OCX_SERVICE_LOG%" echo bun="%OCX_BUN%"
>>"%OCX_SERVICE_LOG%" echo bun_source="standalone"
>>"%OCX_SERVICE_LOG%" echo cli="%OCX_CLI%"
>>"%OCX_SERVICE_LOG%" echo opencodex_home="%OPENCODEX_HOME%"
>>"%OCX_SERVICE_LOG%" echo codex_home="%CODEX_HOME%"
>>"%OCX_SERVICE_LOG%" echo token_file="%OCX_API_TOKEN_FILE%"
if not exist "%OCX_BUN%" (
  call :restore_backup
)
if not exist "%OCX_BUN%" goto bun_missing
"%OCX_BUN%" start --port 10100 >>"%OCX_SERVICE_LOG%" 2>&1
if "%ERRORLEVEL%"=="42" goto stopped
>>"%OCX_SERVICE_LOG%" echo [%DATE% %TIME%] child exited with code %ERRORLEVEL%; restarting in 5s
ping -n 6 127.0.0.1 >nul
goto loop
:stopped
endlocal
exit /b 0
:bun_missing
>>"%OCX_SERVICE_LOG%" echo [%DATE% %TIME%] installation is incomplete: bundled Bun is missing; reinstall opencodex, then run ocx service repair
exit /b 3
:restore_backup
>>"%OCX_SERVICE_LOG%" echo [%DATE% %TIME%] install incomplete - looking for a transactional-update backup to restore
for /f "delims=" %%B in ('dir /b /ad /o-n "%OCX_PKG_DIR%\..\.ocx-backup-*" 2^>nul') do (
  if exist "%OCX_PKG_DIR%\..\%%B\opencodex\package.json" (
    if exist "%OCX_PKG_DIR%" rmdir /s /q "%OCX_PKG_DIR%" 2>nul
    move "%OCX_PKG_DIR%\..\%%B\opencodex" "%OCX_PKG_DIR%" >nul 2>&1
    if exist "%OCX_PKG_DIR%\package.json" (
      set "OCX_RESTORED_BACKUP=%%B"
      goto backup_restored
    )
  )
)
>>"%OCX_SERVICE_LOG%" echo [%DATE% %TIME%] no restorable backup found
goto :eof
:backup_restored
>>"%OCX_SERVICE_LOG%" echo [%DATE% %TIME%] restored previous install from %OCX_RESTORED_BACKUP%
goto :eof
