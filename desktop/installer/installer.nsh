; Included by electron-builder's NSIS template (nsis.include in electron-builder.yml).
;
; #1759: the GPU process runs in Chromium's LPAC sandbox, which can only read
; the app folder when its ACL grants ALL RESTRICTED APPLICATION PACKAGES
; (S-1-15-2-2). A per-user install under %LOCALAPPDATA%\Programs inherits the
; profile ACL, and when that carries an orphaned S-1-15-... SID the sandboxed
; GPU process cannot load its ICU data and the app dies with "GPU process isn't
; usable. Goodbye." (electron/electron#51761). Granting the SID on the install
; folder fixes it. Runs on every install and update; failure is not fatal, the
; app has a runtime fallback (src/gpu-recovery.ts).
!macro customInstall
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "$INSTDIR" /grant *S-1-15-2-2:(OI)(CI)(RX) /T /C /Q'
  Pop $0
  DetailPrint "GPU sandbox folder access (S-1-15-2-2): icacls exit $0"
!macroend
