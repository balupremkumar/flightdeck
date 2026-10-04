; hooks.nsh - NSIS installer hooks (bundle.windows.nsis.installerHooks).
;
; NSIS_HOOK_PREINSTALL snapshots the CURRENT user state before this installer
; touches anything, so a bad release can be reverted with tools\revert.ps1.
; Layout (also written by tools\backup-now.ps1 and read by tools\revert.ps1):
;
;   %APPDATA%\<identifier>\backups\<old-version>-<yyyyMMdd-HHmmss>\
;       appdata\        everything in %APPDATA%\<identifier> EXCEPT
;                       worktrees\, logs\ and backups\
;       local-storage\  %LOCALAPPDATA%\<identifier>\EBWebView\Default\Local Storage
;                       (the webview's localStorage: all UI settings live there)
;
; <old-version> comes from last-version.txt, written by the app on every
; startup (src-tauri/src/updates.rs write_last_version). No marker (first
; install, or a build from before the marker existed) means "unknown".
;
; ${BUNDLEID} is the Tauri identifier, so the canary installer
; (ai.flightdeck.canary) backs up its OWN folders, never stable's.
;
; Strictly best effort: every step ignores failure. A backup problem must
; never block an install. robocopy skips files that are locked (/R:0 /W:0),
; so this still works if the old app was left running.
;
; Registers: every user register ($0-$9, $R0-$R9) is saved and restored, so
; the surrounding installer code never sees them change.

!macro FD_BackupState ROAMING LOCALAPP ID
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8
  Push $9
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4

  ; $R3 = this flavour's roaming data folder.
  StrCpy $R3 "${ROAMING}\${BUNDLEID}"

  IfFileExists "$R3\*.*" 0 fd_done_${ID}

  ; $R0 = old version, from the marker file ("unknown" when absent/empty).
  StrCpy $R0 ""
  ClearErrors
  FileOpen $R1 "$R3\last-version.txt" r
  IfErrors fd_marker_read_${ID}
  FileRead $R1 $R0 32
  FileClose $R1
  fd_marker_read_${ID}:
  fd_trim_${ID}:
    StrCpy $R2 $R0 1 -1
    StrCmp $R2 "$\r" fd_chop_${ID}
    StrCmp $R2 "$\n" fd_chop_${ID}
    StrCmp $R2 " " fd_chop_${ID} fd_trimmed_${ID}
  fd_chop_${ID}:
    StrCpy $R0 $R0 -1
    Goto fd_trim_${ID}
  fd_trimmed_${ID}:
  StrCmp $R0 "" 0 +2
    StrCpy $R0 "unknown"

  ; Local time via GetLocalTime. SYSTEMTIME is eight WORDs:
  ; year, month, day-of-week, day, hour, minute, second, milliseconds.
  System::Call '*(&i2,&i2,&i2,&i2,&i2,&i2,&i2,&i2)p.r9'
  System::Call 'kernel32::GetLocalTime(p r9)'
  System::Call '*$9(&i2.r0,&i2.r1,&i2.r2,&i2.r3,&i2.r4,&i2.r5,&i2.r6,&i2.r7)'
  System::Free $9
  IntFmt $0 "%04d" $0
  IntFmt $1 "%02d" $1
  IntFmt $3 "%02d" $3
  IntFmt $4 "%02d" $4
  IntFmt $5 "%02d" $5
  IntFmt $6 "%02d" $6

  ; $R4 = backup folder: <roaming>\backups\<old-version>-<yyyyMMdd-HHmmss>
  StrCpy $R4 "$R3\backups\$R0-$0$1$3-$4$5$6"

  DetailPrint "Backing up Flightdeck data (version $R0) to $R4"
  CreateDirectory "$R4"

  ; Roaming app data, minus worktrees\, logs\ and backups\ (full paths, so a
  ; same-named folder deeper in the tree is still copied).
  nsExec::Exec 'robocopy "$R3" "$R4\appdata" /E /R:0 /W:0 /NFL /NDL /NJH /NJS /NP /XD "$R3\worktrees" "$R3\logs" "$R3\backups"'
  Pop $R1

  ; Webview localStorage (every UI setting). Absent on a machine that never
  ; ran the app; robocopy then just reports "source not found", ignored.
  IfFileExists "${LOCALAPP}\${BUNDLEID}\EBWebView\Default\Local Storage\*.*" 0 fd_done_${ID}
  nsExec::Exec 'robocopy "${LOCALAPP}\${BUNDLEID}\EBWebView\Default\Local Storage" "$R4\local-storage" /E /R:0 /W:0 /NFL /NDL /NJH /NJS /NP'
  Pop $R1

  fd_done_${ID}:
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
  Pop $9
  Pop $8
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro FD_BackupState "$APPDATA" "$LOCALAPPDATA" "preinstall"
!macroend
