# PyInstaller spec for Clinikore.
#
# Run from the project root on a WINDOWS machine:
#   pyinstaller --clean --noconfirm installer/clinikore.spec
#
# Output: dist\Clinikore-win-x64\Clinikore.exe or
#         dist\Clinikore-win-x86\Clinikore.exe  (plus runtime files)
# Feed that into Inno Setup to produce the architecture-specific Setup.exe.

import os
from pathlib import Path

# `SPECPATH` is injected by PyInstaller and points at this spec's directory.
ROOT = Path(SPECPATH).parent

# Absolute paths (forward slashes are fine — PyInstaller normalizes).
ENTRY = str(ROOT / "launcher.py")
FRONTEND_DIST = str(ROOT / "frontend" / "dist")
ICON = str(ROOT / "assets" / "clinikore.ico")
BUILD_SUFFIX = os.environ.get("CLINIKORE_BUILD_SUFFIX", "win-x64")
DIST_NAME = f"Clinikore-{BUILD_SUFFIX}"

# If no custom icon is present, skip the icon argument.
icon_arg = ICON if Path(ICON).is_file() else None

block_cipher = None

a = Analysis(
    [ENTRY],
    pathex=[str(ROOT)],
    binaries=[],
    # Ship the built React bundle alongside the exe. Backend/main.py picks it
    # up via the same relative path `frontend/dist` at runtime.
    datas=[(FRONTEND_DIST, "frontend/dist")],
    hiddenimports=[
        # Uvicorn does runtime imports PyInstaller can't see statically.
        "uvicorn.logging",
        "uvicorn.loops",
        "uvicorn.loops.auto",
        "uvicorn.protocols",
        "uvicorn.protocols.http",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.http.h11_impl",
        "uvicorn.protocols.websockets",
        "uvicorn.protocols.websockets.auto",
        "uvicorn.protocols.websockets.websockets_impl",
        "uvicorn.lifespan",
        "uvicorn.lifespan.on",
        # FastAPI / Starlette pull these via string.
        "email.mime",
        "email.mime.multipart",
        "email.mime.text",
        # Pydantic v2
        "pydantic.deprecated.decorator",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="Clinikore",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,                # UPX can break pywebview DLLs on some systems
    console=False,            # no black console window — this is a GUI app
    icon=icon_arg,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name=DIST_NAME,
)
