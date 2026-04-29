@echo off
REM ============================================================
REM Clinikore — Windows installer builder
REM
REM Produces:  dist\installer\Clinikore-Setup-<version>-win-x64.exe
REM            dist\installer\Clinikore-Setup-<version>-win-x86.exe
REM
REM Usage:
REM   installer\build.bat       (defaults to x64)
REM   installer\build.bat x64
REM   installer\build.bat x86
REM
REM Run this ONCE (per release) on a Windows machine. The doctor
REM never sees this — they only see the produced Setup.exe.
REM
REM Prerequisites on the build machine (one-time):
REM   1. Python 3.8.10 from python.org (x64 for x64 builds, x86 for x86 builds)
REM   2. Node.js LTS from nodejs.org
REM   3. Inno Setup 6 from https://jrsoftware.org/isinfo.php
REM ============================================================
setlocal enabledelayedexpansion
title Clinikore - Installer Builder

set "SCRIPT_DIR=%~dp0"
pushd "%SCRIPT_DIR%.."
set "ROOT=%CD%"

set "TARGET_ARCH=%~1"
if "%TARGET_ARCH%"=="" set "TARGET_ARCH=x64"
if /I "%TARGET_ARCH%"=="amd64" set "TARGET_ARCH=x64"
if /I "%TARGET_ARCH%"=="x64" (
  set "TARGET_ARCH=x64"
  set "BUILD_SUFFIX=win-x64"
  set "EXPECTED_BITS=64"
  set "PYTHON_CMD=py -3.8-64"
) else if /I "%TARGET_ARCH%"=="x86" (
  set "TARGET_ARCH=x86"
  set "BUILD_SUFFIX=win-x86"
  set "EXPECTED_BITS=32"
  set "PYTHON_CMD=py -3.8-32"
) else (
  echo   [X] Unknown architecture "%TARGET_ARCH%".
  echo       Use: installer\build.bat x64
  echo        or: installer\build.bat x86
  goto :error
)

echo.
echo ================================================
echo   Clinikore - building Windows installer (%BUILD_SUFFIX%)
echo ================================================
echo.

REM --- [1/5] Python deps (incl. PyInstaller) ------------------
echo [1/5] Python dependencies...
%PYTHON_CMD% --version >nul 2>nul
if errorlevel 1 (
  set "PYTHON_CMD=py -3.8"
  py -3.8 --version >nul 2>nul
)
if errorlevel 1 (
  set "PYTHON_CMD=python"
)

%PYTHON_CMD% --version >nul 2>nul || (
  echo   [X] Python 3.8 was not found.
  echo       Install Python 3.8.10 (%EXPECTED_BITS%-bit) from:
  echo       https://www.python.org/downloads/release/python-3810/
  goto :error
)

set "VCODE="
for /f %%V in ('%PYTHON_CMD% -c "import sys;print(sys.version_info[0]*100+sys.version_info[1])" 2^>nul') do set "VCODE=%%V"
if not "%VCODE%"=="308" (
  echo   [X] The Windows installer must be built with Python 3.8.x.
  echo       Found:
  %PYTHON_CMD% --version
  echo.
  echo       Python 3.8.10 is the last python.org Windows runtime that supports Windows 7.
  goto :error
)

set "PY_BITS="
for /f %%V in ('%PYTHON_CMD% -c "import sys;print(64 if sys.maxsize ^> 2**32 else 32)" 2^>nul') do set "PY_BITS=%%V"
if not "%PY_BITS%"=="%EXPECTED_BITS%" (
  echo   [X] The %BUILD_SUFFIX% installer must be built with %EXPECTED_BITS%-bit Python.
  echo       Found %PY_BITS%-bit Python:
  %PYTHON_CMD% --version
  echo.
  echo       Install Python 3.8.10 %EXPECTED_BITS%-bit and rerun:
  echo       installer\build.bat %TARGET_ARCH%
  goto :error
)

if exist .venv\Scripts\python.exe (
  set "VENV_VCODE="
  for /f %%V in ('.venv\Scripts\python.exe -c "import sys;print(sys.version_info[0]*100+sys.version_info[1])" 2^>nul') do set "VENV_VCODE=%%V"
  set "VENV_BITS="
  for /f %%V in ('.venv\Scripts\python.exe -c "import sys;print(64 if sys.maxsize ^> 2**32 else 32)" 2^>nul') do set "VENV_BITS=%%V"
  if not "!VENV_VCODE!"=="308" (
    echo   [!] Existing .venv was not Python 3.8; recreating it.
    rmdir /s /q .venv
  ) else if not "!VENV_BITS!"=="%EXPECTED_BITS%" (
    echo   [!] Existing .venv was not %EXPECTED_BITS%-bit; recreating it.
    rmdir /s /q .venv
  )
)

if not exist .venv ( %PYTHON_CMD% -m venv .venv )
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
if exist "dist\Clinikore-%BUILD_SUFFIX%" rmdir /s /q "dist\Clinikore-%BUILD_SUFFIX%"
set "CLINIKORE_BUILD_SUFFIX=%BUILD_SUFFIX%"
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
"%ISCC%" /DAppArch=%TARGET_ARCH% /DOutputSuffix=%BUILD_SUFFIX% /DSourceDir=Clinikore-%BUILD_SUFFIX% "%SCRIPT_DIR%installer.iss"
if errorlevel 1 goto :error

REM --- [5/5] Done --------------------------------------------
echo.
echo ================================================
echo   BUILD SUCCESSFUL
echo.
echo   Installer is at:
echo       %ROOT%\dist\installer\
echo.
echo   Ship Clinikore-Setup-*-%BUILD_SUFFIX%.exe to the doctor.
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
