# Building the Clinikore Windows installer

You (the developer) run this **once per release** on any Windows machine that
can run the build tools. The release workflow produces four installers:

- `Clinikore-Setup-<version>-win-x64.exe` for most Windows 7/10/11 laptops.
- `Clinikore-Setup-<version>-win-x86.exe` for 32-bit Windows machines.
- `Clinikore-Setup-<version>-win7-legacy-x64.exe` for 64-bit base/unpatched Windows 7.
- `Clinikore-Setup-<version>-win7-legacy-x86.exe` for 32-bit base/unpatched Windows 7.

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
   PATH"* during install.
2. **Python 3.7.9** from
   <https://www.python.org/downloads/release/python-379/> — install
   x64 for `win7-legacy-x64` builds and x86 for `win7-legacy-x86` builds. This
   runtime avoids Python 3.8's newer DLL loader behavior on base Windows 7.
3. **Node.js LTS** from <https://nodejs.org/>.
4. **Inno Setup 6** from <https://jrsoftware.org/isinfo.php> — "Unicode" version,
   default install path.
5. (Optional) An `assets/clinikore.ico` file in the project root — a 256×256
   multi-resolution ICO works best. If missing, the installer falls back to
   Python's default icon.

## Build

From the project root on a Windows machine:

```cmd
installer\build.bat x64
installer\build.bat x86
installer\build.bat win7-legacy-x64
installer\build.bat win7-legacy-x86
```

Omit the argument to default to `x64`. Under the hood it:

1. Creates / refreshes the `.venv` and installs either `requirements.txt` or
   `requirements-win7-legacy.txt`.
2. `npm install && npm run build` in `frontend/`.
3. Runs **PyInstaller** with `installer/clinikore.spec` to bundle the selected
   Python runtime + dependencies + the React `dist/` into an architecture-
   specific folder such as `dist/Clinikore-win-x64/` or
   `dist/Clinikore-win7-legacy-x86/`.
4. Runs **Inno Setup** with `installer/installer.iss` to wrap that folder into
   an architecture-specific installer in `dist/installer/`.

For releases, ship all `.exe` files. Tell users: choose `win-x64` unless
Windows says it is not compatible with the computer; then use `win-x86`. On
base/unpatched Windows 7, or if Python DLL/procedure errors appear, use the
matching `win7-legacy-*` installer. Zip files if your email provider blocks
`.exe` attachments.

## What the doctor sees

1. Double-click the matching installer, for example
   `Clinikore-Setup-0.1.0-win-x64.exe` or
   `Clinikore-Setup-0.1.0-win7-legacy-x86.exe`.
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
3. Run the needed `installer\build.bat ...` targets again, or use the GitHub
   release workflow to build all installers.

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
- **Doctor sees "Failed to load Python DLL" on Windows 7** → use the matching
  `win7-legacy-*` installer. It bundles Python 3.7.9 and Pydantic v1 to avoid
  Python 3.8 loader APIs and Pydantic v2's Rust core on base Windows 7.
- **Windows says the installer is not compatible** → the doctor likely chose
  `win-x64` on 32-bit Windows. Use `win-x86`.
- **Doctor's Win 10 says "WebView2 Runtime missing"** → ship the free
  standalone installer from <https://developer.microsoft.com/en-us/microsoft-edge/webview2/>
  alongside your setup.exe, or add a bootstrapper task to `installer.iss` that
  downloads it.
- **Doctor is on Windows 7 and does not have Chrome** → install Chrome/Chromium
  or set any browser as the default. Clinikore will fall back to the default
  browser if Chrome is not found.
