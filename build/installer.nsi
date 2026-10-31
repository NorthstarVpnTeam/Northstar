!define PRODUCT_VERSION "2.0.0"
!define PRODUCT_PUBLISHER "shupolol"
!define PRODUCT_WEB_SITE "https://github.com/shupolol/Northstar"
!define PRODUCT_DIR_REGKEY "Software\Microsoft\Windows\CurrentVersion\App Paths\Northstar V2Ray.exe"
!define PRODUCT_UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}"
!define PRODUCT_UNINST_ROOT_KEY "HKLM"

!include "MUI2.nsh"
!include "x64.nsh"
!include "WinVer.nsh"
!include "LogicLib.nsh"

!define MUI_ABORTWARNING

!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_BITMAP "${PROJECT_DIR}\build\header.bmp"

;--------------------------------
; Pages
;--------------------------------

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${PROJECT_DIR}\LICENSE"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_WELCOME
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH

;--------------------------------
; Languages
;--------------------------------

!insertmacro MUI_LANGUAGE "English"

;--------------------------------
; Installer sections
;--------------------------------

InstallDir "$PROGRAMFILES64\${PRODUCT_NAME}"

Section "Northstar V2Ray Application" SEC01
  SetOutPath "$INSTDIR"
  File /r "${PROJECT_DIR}\src\**"
  File /r "${PROJECT_DIR}\scripts\**"
  File /r "${PROJECT_DIR}\core\**"
  File "${PROJECT_DIR}\package.json"
SectionEnd

Section "Desktop Shortcut" SEC02
  CreateShortCut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\${PRODUCT_NAME}.exe"
SectionEnd

Section "Start Menu Shortcut" SEC03
  CreateShortCut "$SMPrograms\${PRODUCT_NAME}.lnk" "$INSTDIR\${PRODUCT_NAME}.exe"
SectionEnd

;--------------------------------
; Functions
;--------------------------------

Function LicensePageShow
FunctionEnd

Function InstFilesPageShow
FunctionEnd

Function .onInit
  ; Check if already installed
  ReadRegStr $R0 HKLM "${PRODUCT_UNINST_KEY}" "DisplayName"
  ${If} $R0 == "${PRODUCT_NAME}"
    MessageBox MB_OKCANCEL "Northstar V2Ray is already installed. Reinstall?" IDOK +2
      Abort
  ${EndIf}
FunctionEnd

Function .onInstSuccess
  ; Launch app after install
  Exec "$INSTDIR\${PRODUCT_NAME}.exe"
FunctionEnd

Function un.onInit
  MessageBox MB_ICONQUESTION|MB_YESNO|MB_DEFBUTTON2 "Are you sure you want to uninstall Northstar V2Ray?" IDYES +2
    Abort
FunctionEnd

Function un.onUninstSuccess
FunctionEnd

Function WriteUninstaller
  DetailPrint "Northstar V2Ray uninstaller"
FunctionEnd

;--------------------------------
; UI customizations
;--------------------------------

!define MUI_WELCOMEPAGE_TITLE "Welcome to the Northstar V2Ray Setup Wizard"
!define MUI_WELCOMEPAGE_TEXT "This wizard will install Northstar V2Ray on your computer.$\r$\n$\r$\nA polished V2Ray-compatible proxy configuration manager and client for Windows."

!define MUI_FINISHPAGE_TITLE "Completing the Northstar V2Ray Setup Wizard"
!define MUI_FINISHPAGE_TEXT "Northstar V2Ray has been installed on your computer.$\r$\n$\r$\nClick Finish to launch the application."

;--------------------------------
; Branding
;--------------------------------

BrandingText "Northstar V2Ray"
