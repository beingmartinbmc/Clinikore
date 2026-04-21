@echo off
REM ============================================================
REM Clinikore — Windows installer builder
REM
REM Produces:  dist\installer\Clinikore-Setup-<version>.exe
REM
REM Run this ONCE (per release) on a Windows machine. The doctor
REM never sees this — they only see the produced Setup.exe.
REM
REM Prerequisites on the build machine (one-time):
REM   1. Python 3.12 from python.org (tick "Add to PATH")
REM   2. Node.js LTS from nodejs.org
REM   3. Inno Setup 6 from https://jrsoftware.org/isinfo.php
REM ============================================================
setlocal enabledelayedexpansion
title Clinikore - Installer Builder

set "SCRIPT_DIR=%~dp0"
pushd "%SCRIPT_DIR%.."
set "ROOT=%CD%"

echo.
echo ================================================
echo   Clinikore - building Windows installer
echo ================================================
echo.

REM --- [1/5] Python deps (incl. PyInstaller) ------------------
echo [1/5] Python dependencies...
where python >nul 2>nul || ( echo   [X] Python not found on PATH. & goto :error )
if not exist .venv ( python -m venv .venv )
call .venv\Scripts\activate.bat
python -m pip install --upgrade pip >nul
python -m pip install --upgrade -r requirements.txt pyinstaller
if errorlevel 1 goto :error

REM --- [2/5] Frontend build ----------------------------------
echo [2/5] Frontend build...
where npm >nul 2>nul || ( echo   [X] Node.js / npm not found. & goto :error )
pushd frontend
call npm install
if errorlevel 1 ( popd & goto :error )
call npm run build
if errorlevel 1 ( popd & goto :error )
popd

REM --- [3/5] PyInstaller ------------------------------------
echo [3/5] PyInstaller (bundling Python + app into one folder)...
if exist dist\Clinikore rmdir /s /q dist\Clinikore
pyinstaller --clean --noconfirm "%SCRIPT_DIR%clinikore.spec"
if errorlevel 1 goto :error

REM --- [4/5] Inno Setup -------------------------------------
echo [4/5] Inno Setup (wrapping into Setup.exe)...
set "ISCC=%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe"
if not exist "%ISCC%" set "ISCC=%ProgramFiles%\Inno Setup 6\ISCC.exe"
if not exist "%ISCC%" (
  echo   [X] Inno Setup 6 not installed.
  echo       Download: https://jrsoftware.org/isinfo.php
  goto :error
)
"%ISCC%" "%SCRIPT_DIR%installer.iss"
if errorlevel 1 goto :error

REM --- [5/5] Done --------------------------------------------
echo.
echo ================================================
echo   BUILD SUCCESSFUL
echo.
echo   Installer is at:
echo       %ROOT%\dist\installer\
echo.
echo   Ship that single Clinikore-Setup-*.exe to the doctor.
echo ================================================
echo.
pause
popd
exit /b 0

:error
echo.
echo ================================================
echo   BUILD FAILED. See messages above.
echo ================================================
echo.
pause
popd
exit /b 1
