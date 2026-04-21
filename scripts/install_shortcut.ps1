# Creates a Desktop shortcut + Start Menu entry for Clinikore.
# Called from install.bat with the project root as the first argument.
#
# We target pythonw.exe (the windowed Python launcher) instead of python.exe
# so that clicking the shortcut doesn't flash a black console window.

param(
  [Parameter(Mandatory=$true)][string]$RootDir
)

$ErrorActionPreference = "Stop"

function New-ClinikoreShortcut {
  param([string]$LinkPath)

  $ws   = New-Object -ComObject WScript.Shell
  $link = $ws.CreateShortcut($LinkPath)
  $link.TargetPath       = Join-Path $RootDir ".venv\Scripts\pythonw.exe"
  $link.Arguments        = "main.py"
  $link.WorkingDirectory = $RootDir
  $link.Description      = "Clinikore - Offline Clinic Manager"

  # Use a bundled .ico if present; otherwise fall back to pythonw.exe's default.
  $iconPath = Join-Path $RootDir "assets\clinikore.ico"
  if (Test-Path $iconPath) { $link.IconLocation = $iconPath }

  $link.Save()
}

# --- Desktop ---
$desktop = [Environment]::GetFolderPath("Desktop")
$desktopLink = Join-Path $desktop "Clinikore.lnk"
New-ClinikoreShortcut -LinkPath $desktopLink
Write-Host "  [OK] Desktop shortcut: $desktopLink"

# --- Start Menu (Programs) ---
$startMenu = [Environment]::GetFolderPath("Programs")
$smFolder  = Join-Path $startMenu "Clinikore"
if (-not (Test-Path $smFolder)) { New-Item -ItemType Directory -Path $smFolder | Out-Null }
$smLink = Join-Path $smFolder "Clinikore.lnk"
New-ClinikoreShortcut -LinkPath $smLink
Write-Host "  [OK] Start Menu:      $smLink"
