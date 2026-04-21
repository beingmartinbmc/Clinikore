# Building the Clinikore Windows installer

You (the developer) run this **once per release** on any Windows 10/11 machine.
It produces a single `Clinikore-Setup-<version>.exe` that doctors double-click
to get a fully-installed app with Desktop + Start Menu shortcuts.

The doctor's machine needs **no Python, no Node, no scripts**. They only need:

- Windows 10/11
- Microsoft Edge WebView2 Runtime (pre-installed on Win 11 and recent Win 10)

## What you need on the build machine (one-time)

1. **Python 3.12** from <https://www.python.org/downloads/windows/> — tick
   *"Add python.exe to PATH"* during install.
2. **Node.js LTS** from <https://nodejs.org/>.
3. **Inno Setup 6** from <https://jrsoftware.org/isinfo.php> — "Unicode" version,
   default install path.
4. (Optional) An `assets/clinikore.ico` file in the project root — a 256×256
   multi-resolution ICO works best. If missing, the installer falls back to
   Python's default icon.

## Build

From the project root on a Windows machine:

```cmd
installer\build.bat
```

That's it. Under the hood it:

1. Creates / refreshes the `.venv` and installs `requirements.txt` + PyInstaller.
2. `npm install && npm run build` in `frontend/`.
3. Runs **PyInstaller** with `installer/clinikore.spec` to bundle Python + all
   dependencies + the React `dist/` into `dist/Clinikore/`.
4. Runs **Inno Setup** with `installer/installer.iss` to wrap that folder into
   `dist/installer/Clinikore-Setup-<version>.exe`.

Ship the single `.exe` file in `dist/installer/` — zip it if your email
provider blocks `.exe` attachments.

## What the doctor sees

1. Double-click `Clinikore-Setup-0.1.0.exe`.
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
3. Run `installer\build.bat` again.

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
- **Doctor's Win 10 says "WebView2 Runtime missing"** → ship the free
  standalone installer from <https://developer.microsoft.com/en-us/microsoft-edge/webview2/>
  alongside your setup.exe, or add a bootstrapper task to `installer.iss` that
  downloads it.
