; Clinikore Windows installer
; ---------------------------
; Compile with Inno Setup 6 (https://jrsoftware.org/isinfo.php).
;
; Expects that PyInstaller has already produced an architecture-specific folder
; under `dist\` (for example `dist\Clinikore-win-x64\`). Run
; installer\build.bat to do both steps in one go.
;
; Produces:    dist\installer\Clinikore-Setup-<version>-win-x64.exe
;              dist\installer\Clinikore-Setup-<version>-win-x86.exe
;              dist\installer\Clinikore-Setup-<version>-win7-legacy-x64.exe
;              dist\installer\Clinikore-Setup-<version>-win7-legacy-x86.exe
; Install into: %LOCALAPPDATA%\Programs\Clinikore  (per-user, no admin)

#define AppName      "Clinikore"
; AppVersion can be overridden from the command line with
; /DAppVersion=x.y.z (used by CI so the tag drives the installer version).
#ifndef AppVersion
  #define AppVersion "0.3.4"
#endif
#ifndef AppArch
  #define AppArch "x64"
#endif
#ifndef OutputSuffix
  #define OutputSuffix "win-x64"
#endif
#ifndef SourceDir
  #define SourceDir "Clinikore-win-x64"
#endif
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
OutputBaseFilename=Clinikore-Setup-{#AppVersion}-{#OutputSuffix}

; Windows 7 SP1 is the oldest supported target. Base/unpatched Win7 should use
; the win7-legacy builds, which bundle Python 3.7.9 and Pydantic v1.
MinVersion=6.1sp1

; Nice modern look
WizardStyle=modern
; SetupIconFile is optional — only reference it if the file actually exists.
; Drop a 256x256 .ico at assets\clinikore.ico and this will pick it up
; automatically on the next build.
#if FileExists(AddBackslash(SourcePath) + "..\assets\clinikore.ico")
SetupIconFile=..\assets\clinikore.ico
#endif
UninstallDisplayIcon={app}\{#AppExeName}
UninstallDisplayName={#AppName}

; Compression
Compression=lzma2/ultra
SolidCompression=yes

; x64 installers are restricted to 64-bit-capable Windows. x86 installers leave
; these directives unset, so they run on 32-bit Windows and under WOW64.
#if AppArch == "x64"
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
#endif

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; \
  Description: "{cm:CreateDesktopIcon}"; \
  GroupDescription: "{cm:AdditionalIcons}"

[Files]
; Everything PyInstaller produced under the selected dist folder ships as-is.
Source: "..\dist\{#SourceDir}\*"; \
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
