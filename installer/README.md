# Building the Clinikore Windows installer

You (the developer) run this **once per release** on any Windows machine that
can run the build tools. The release workflow produces two installers:

- `Clinikore-Setup-<version>-win-x64.exe` for most Windows 7/10/11 laptops.
- `Clinikore-Setup-<version>-win-x86.exe` for 32-bit Windows machines.

Doctors double-click the matching file to get a fully-installed app with
Desktop + Start Menu shortcuts.

The doctor's machine needs **no Python, no Node, no scripts**. Supported targets:

- Windows 7 SP1 x86/x64: opens Clinikore in Chrome/app-browser mode because
  modern Edge WebView2 is no longer supported there.
- Windows 10/11 x86/x64: opens Clinikore in the native Edge WebView2 desktop
  window (install the WebView2 Runtime if it is missing).

## What you need on the build machine (one-time)

1. **Python 3.8.10** from
   <https://www.python.org/downloads/release/python-3810/> — install x64 for
   `win-x64` builds and x86 for `win-x86` builds. Tick *"Add python.exe to
   PATH"* during install. This older runtime is intentional: it is the last
   python.org Windows runtime that supports Windows 7.
2. **Node.js LTS** from <https://nodejs.org/>.
3. **Inno Setup 6** from <https://jrsoftware.org/isinfo.php> — "Unicode" version,
   default install path.
4. (Optional) An `assets/clinikore.ico` file in the project root — a 256×256
   multi-resolution ICO works best. If missing, the installer falls back to
   Python's default icon.

## Build

From the project root on a Windows machine:

```cmd
installer\build.bat x64
installer\build.bat x86
```

Omit the argument to default to `x64`. Under the hood it:

1. Creates / refreshes the `.venv` and installs `requirements.txt` + PyInstaller.
2. `npm install && npm run build` in `frontend/`.
3. Runs **PyInstaller** with `installer/clinikore.spec` to bundle Python 3.8 +
   all dependencies + the React `dist/` into `dist/Clinikore-win-x64/` or
   `dist/Clinikore-win-x86/`.
4. Runs **Inno Setup** with `installer/installer.iss` to wrap that folder into
   `dist/installer/Clinikore-Setup-<version>-win-x64.exe` or
   `dist/installer/Clinikore-Setup-<version>-win-x86.exe`.

For releases, ship both `.exe` files. Tell users: choose `win-x64` unless
Windows says it is not compatible with the computer; then use `win-x86`. Zip
them if your email provider blocks `.exe` attachments.

## What the doctor sees

1. Double-click `Clinikore-Setup-0.1.0-win-x64.exe` or
   `Clinikore-Setup-0.1.0-win-x86.exe`.
2. Windows may warn about an unsigned publisher (see signing section below).
   Click *More info → Run anyway*.
3. A modern wizard: Welcome → License (optional) → Install location → Ready → **Install**.
4. Tick the *"Create desktop shortcut"* option.
5. Finish → **Launch Clinikore**. The clinic window opens.
6. Every day after: double-click the **Clinikore** icon on Desktop or in Start Menu.

Uninstalling is equally clean: *Settings → Apps → Clinikore → Uninstall*. The
uninstaller **does not** touch the clinic database — that lives at
`%USERPROFILE%\.clinikore\clinic.db` and must survive reinstalls.

## Version bump

When you release a new version:

1. Edit `#define AppVersion "x.y.z"` in `installer/installer.iss`.
2. Edit `APP_VERSION` in `backend/main.py` to match.
3. Run `installer\build.bat x64` and `installer\build.bat x86` again, or use
   the GitHub release workflow to build both.

The `AppId` GUID in the `.iss` is stable across versions — Inno Setup uses it
to detect the previous install and upgrade in place.

## Code signing (recommended for production)

An unsigned installer shows a SmartScreen warning. To remove it, sign the exe
with an EV Code Signing Certificate ($200–$400/year from DigiCert, Sectigo,
etc.). Add this line to `installer.iss` after purchasing a cert:

```
SignTool=mysigntool sign /f "C:\path\to\cert.pfx" /p YOURPASSWORD \
  /tr http://timestamp.digicert.com /td sha256 /fd sha256 $f
SignedUninstaller=yes
```

And register your sign tool at the top of `installer.iss`:

```
[Setup]
SignTool=mysigntool
```

After a few signed downloads, Windows SmartScreen will stop warning and show
*"Publisher: Your Name"* instead of *"Unknown publisher"*.

## Troubleshooting

- **"ModuleNotFoundError: No module named 'xyz'"** at runtime on the doctor's
  machine → add `xyz` to the `hiddenimports` list in `clinikore.spec` and rebuild.
- **Installer is huge (>80 MB)** → that's normal; it includes Python, Qt-free
  pywebview, SQLite, FastAPI, ReportLab, and the React bundle. We already
  disable UPX because it breaks pywebview on some systems; leave it off.
- **Doctor sees "Failed to load Python DLL" on Windows 7** → rebuild the
  installer with Python 3.8.10 for the target architecture. Python 3.9+ /
  3.10+ / 3.11+ / 3.12+ runtimes do not support Windows 7 and will fail before
  the app starts.
- **Windows says the installer is not compatible** → the doctor likely chose
  `win-x64` on 32-bit Windows. Use `win-x86`.
- **Doctor's Win 10 says "WebView2 Runtime missing"** → ship the free
  standalone installer from <https://developer.microsoft.com/en-us/microsoft-edge/webview2/>
  alongside your setup.exe, or add a bootstrapper task to `installer.iss` that
  downloads it.
- **Doctor is on Windows 7 and does not have Chrome** → install Chrome/Chromium
  or set any browser as the default. Clinikore will fall back to the default
  browser if Chrome is not found.
