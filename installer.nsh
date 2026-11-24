!macro customUnInstall
  ; Só limpa na desinstalação manual (nunca durante atualização automática)
  ${ifNot} ${isUpdated}
    ; Remove a entrada de inicialização com o Windows criada pelo Electron
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.Podi Pedir Balança"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Podi Pedir Balança"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "electron.app.Podi Pedir Balança"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "Podi Pedir Balança"

    ; Remove o cache do atualizador automático
    RMDir /r "$LOCALAPPDATA\balance-agent-updater"
  ${endIf}
!macroend
