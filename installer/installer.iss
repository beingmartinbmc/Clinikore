; Clinikore Windows installer
; ---------------------------
; Compile with Inno Setup 6 (https://jrsoftware.org/isinfo.php).
;
; Expects that PyInstaller has already produced `dist\Clinikore\` in the
; project root. Run installer\build.bat to do both steps in one go.
;
; Produces:    dist\installer\Clinikore-Setup-<version>.exe
; Install into: %LOCALAPPDATA%\Programs\Clinikore  (per-user, no admin)

#define AppName      "Clinikore"
#define AppVersion   "0.1.0"
#define AppPublisher "Clinikore"
#define AppURL       "https://example.com"
#define AppExeName   "Clinikore.exe"

[Setup]
; AppId is a stable GUID — keep it constant across versions so upgrades work.
AppId={{8A4D92F0-5E6B-47B9-B7F1-CLINIKORE0001}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}
AppUpdatesURL={#AppURL}

; Per-user install — no admin password required. Non-technical doctors love this.
PrivilegesRequired=lowest
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
DisableDirPage=auto

OutputDir=..\dist\installer
OutputBaseFilename=Clinikore-Setup-{#AppVersion}

; Nice modern look
WizardStyle=modern
SetupIconFile=..\assets\clinikore.ico
UninstallDisplayIcon={app}\{#AppExeName}
UninstallDisplayName={#AppName}

; Compression
Compression=lzma2/ultra
SolidCompression=yes

; 64-bit only (matches our Python build)
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; \
  Description: "{cm:CreateDesktopIcon}"; \
  GroupDescription: "{cm:AdditionalIcons}"

[Files]
; Everything PyInstaller produced under dist\Clinikore\ ships as-is.
Source: "..\dist\Clinikore\*"; \
  DestDir: "{app}"; \
  Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
; Start Menu
Name: "{autoprograms}\{#AppName}"; \
  Filename: "{app}\{#AppExeName}"; \
  WorkingDir: "{app}"
Name: "{autoprograms}\Uninstall {#AppName}"; \
  Filename: "{uninstallexe}"

; Desktop (optional task)
Name: "{autodesktop}\{#AppName}"; \
  Filename: "{app}\{#AppExeName}"; \
  WorkingDir: "{app}"; \
  Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExeName}"; \
  Description: "{cm:LaunchProgram,{#StringChange(AppName, '&', '&&')}}"; \
  WorkingDir: "{app}"; \
  Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Don't nuke the doctor's data on uninstall — clinic.db lives in
; %USERPROFILE%\.clinikore\ and must survive. These entries clean up only
; the app's own cache if we ever add one under {app}.
Type: filesandordirs; Name: "{app}\_internal\cache"
