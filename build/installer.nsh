; Included by electron-builder's NSIS installer (package.json build.nsis.include).
;
; Leaves a marker next to ViU.exe so the launch that follows installation
; (the finish page's "ViU を実行" checkbox, or an update) can start without
; stealing focus from whatever the user is doing meanwhile — see
; consumeQuietLaunchMarker() in main.js. electron-builder itself only passes
; --updated when driven by electron-updater, not for a manual reinstall, so
; that flag alone can't tell us the launch came from the installer.
!macro customInstall
  FileOpen $0 "$INSTDIR\installed-launch.marker" w
  FileClose $0
!macroend

!macro customUnInstall
  Delete "$INSTDIR\installed-launch.marker"
!macroend
