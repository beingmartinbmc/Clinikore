@echo off
REM Windows launcher. Double-clickable from Explorer.
REM Assumes scripts\install.bat has been run once already.
setlocal enabledelayedexpansion
title Clinikore

set "SCRIPT_DIR=%~dp0"
pushd "%SCRIPT_DIR%.."
set "ROOT_DIR=%CD%"

if not exist .venv\Scripts\activate.bat (
  echo First-time setup is not complete.
  echo Please double-click:  scripts\install.bat
  echo.
  pause
  popd
  exit /b 1
)
if not exist frontend\dist\index.html (
  echo UI bundle missing. Please double-click:  scripts\install.bat
  echo.
  pause
  popd
  exit /b 1
)

call .venv\Scripts\activate.bat
python main.py
set "EXITCODE=%ERRORLEVEL%"
popd
exit /b %EXITCODE%
