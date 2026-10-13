; Opsi uninstall VocaLyx: tawarkan penghapusan data aplikasi.
;
; Dipasang lewat `bundle.windows.nsis.installerHooks` (tanpa fork template
; NSIS penuh). Default = TIDAK hapus (pengguna harus aktif memilih Ya),
; sejalan dengan checkbox MSI yang defaultnya tidak dicentang.

Var VocalyxRemoveData

!macro NSIS_HOOK_PREUNINSTALL
  MessageBox MB_YESNO "Hapus juga data aplikasi VocaLyx di %APPDATA%\VocaLyx?$\nBerisi runtime Python, model AI, dan cache (sekitar 2 GB).$\n$\nAlso delete VocaLyx app data in %APPDATA%\VocaLyx?$\nContains the Python runtime, AI models, and cache (about 2 GB)." IDYES vocalyx_remove_data_yes
  StrCpy $VocalyxRemoveData "0"
  Goto vocalyx_remove_data_done
  vocalyx_remove_data_yes:
  StrCpy $VocalyxRemoveData "1"
  vocalyx_remove_data_done:
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $VocalyxRemoveData == "1"
    DetailPrint "Menghapus data aplikasi VocaLyx di $APPDATA\VocaLyx..."
    RMDir /r "$APPDATA\VocaLyx"
  ${EndIf}
!macroend
