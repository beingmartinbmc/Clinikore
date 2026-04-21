@echo off
REM ============================================================
REM Clinikore - Windows one-click installer
REM Double-click this file the first time you set up the app.
REM It is safe to re-run: nothing is deleted, only re-synced.
REM ============================================================
setlocal enabledelayedexpansion
title Clinikore - Installer

set "SCRIPT_DIR=%~dp0"
pushd "%SCRIPT_DIR%.."
set "ROOT_DIR=%CD%"

echo.
echo ================================================
echo   Clinikore - Installer
echo ================================================
echo.

REM --- [1/5] Python -------------------------------------------
REM We require Python 3.9 - 3.13. Python 3.14 is skipped because
REM pydantic-core doesn't ship wheels for it yet.
echo [1/5] Checking for Python 3.9-3.13...
where python >nul 2>nul
if errorlevel 1 (
  echo   [X] Python is not installed or not on PATH.
  echo.
  echo       Please install Python 3.12 from:
  echo           https://www.python.org/downloads/windows/
  echo       During install, TICK the checkbox:
  echo           "Add python.exe to PATH"
  echo.
  goto :error
)

REM Version check: pack major.minor into a 3-digit number (e.g. 3.12 -> 312).
set "VCODE="
for /f %%V in ('python -c "import sys;print(sys.version_info[0]*100+sys.version_info[1])" 2^>nul') do set "VCODE=%%V"
if not defined VCODE (
  echo   [X] Could not read Python version.
  goto :error
)
if %VCODE% LSS 309 (
  echo   [X] Python %VCODE% is too old. Install Python 3.12 from python.org.
  goto :error
)
if %VCODE% GTR 313 (
  echo   [X] Python version is too new for the current dependency pins.
  echo       Install Python 3.12 or 3.13 from python.org alongside your current one.
  goto :error
)
for /f "delims=" %%V in ('python --version 2^>^&1') do set "PYVER=%%V"
echo   [OK] Found %PYVER%

REM --- [2/5] Node (only if frontend sources are present) ------
if not exist "%ROOT_DIR%\frontend\package.json" (
  echo [2/5] Pre-built UI bundle - Node not required.
) else (
  echo [2/5] Checking for Node.js...
  where npm >nul 2>nul
  if errorlevel 1 (
    echo   [X] Node.js / npm is not installed.
    echo.
    echo       Please install the Node.js LTS version from:
    echo           https://nodejs.org/
    echo       Then re-run this installer.
    echo.
    goto :error
  )
  for /f "delims=" %%V in ('node --version') do set "NODEVER=%%V"
  echo   [OK] Found Node %NODEVER%
)

REM --- [3/5] venv ---------------------------------------------
echo [3/5] Creating Python virtual environment...
if not exist .venv (
  python -m venv .venv
  if errorlevel 1 goto :error
  echo   [OK] venv created at .venv
) else (
  echo   [OK] venv already exists.
)

REM --- [4/5] Python deps --------------------------------------
echo [4/5] Installing / updating Python dependencies (may take a minute)...
call .venv\Scripts\activate.bat
python -m pip install --upgrade pip >nul
REM --upgrade so re-runs pick up any new/changed pins in requirements.txt.
python -m pip install --upgrade -r requirements.txt
if errorlevel 1 goto :error
echo   [OK] Python dependencies installed.

REM --- [5/6] Frontend -----------------------------------------
REM Rebuild whenever frontend sources are present so re-runs pick up new
REM components, translations, etc. If sources are absent (shipped as a
REM pre-built dist/), skip Node entirely.
if exist "%ROOT_DIR%\frontend\package.json" (
  echo [5/6] Installing and building the UI...
  pushd frontend
  call npm install
  if errorlevel 1 ( popd & goto :error )
  call npm run build
  if errorlevel 1 ( popd & goto :error )
  popd
  echo   [OK] UI built into frontend\dist
) else (
  echo [5/6] Pre-built UI bundle - Node not required.
)

REM --- [6/6] Desktop shortcut ---------------------------------
echo [6/6] Creating Desktop + Start Menu shortcuts...
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%install_shortcut.ps1" -RootDir "%ROOT_DIR%"
if errorlevel 1 (
  echo   [!] Shortcut creation failed (not fatal - you can still use scripts\run.bat).
)

echo.
echo ================================================
echo   All done!
echo.
echo   Launch Clinikore by double-clicking the
echo   "Clinikore" icon on your Desktop, or find it
echo   in the Start Menu under "Clinikore".
echo ================================================
echo.
pause
popd
exit /b 0

:error
echo.
echo ================================================
echo   Installation FAILED. See messages above.
echo ================================================
echo.
pause
popd
exit /b 1
