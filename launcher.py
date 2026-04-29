"""Clinikore — desktop launcher.

Starts the FastAPI backend (``backend/main.py``) in a background thread,
waits for it to be ready, then opens a native pywebview window pointing
at it. When the window closes, the backend is torn down.

If pywebview is not installed, this falls back to opening the default browser.

This file is the **desktop entry point**; the HTTP API itself lives in
``backend/main.py``.
"""
from __future__ import annotations

import logging
import os
import socket
import subprocess
import sys
import threading
import time
from contextlib import closing
from typing import Optional

import uvicorn

APP_NAME = "Clinikore"


def _set_app_identity() -> None:
    """Make the running process show up as "Clinikore" instead of
    "Python" in the OS UI and process listings.

    Does three things, all best-effort:

    1. ``setproctitle`` (if installed) fixes the name in ``ps``,
       ``top``, ``htop``, Activity Monitor's *Process Name* column,
       and the Windows Task Manager.
    2. On macOS, overriding the ``CFBundleName`` / ``CFBundleDisplayName``
       keys of the main bundle fixes the name in the Dock, the app
       menu bar, and the "About" dialog. pywebview requires PyObjC
       anyway so ``Foundation`` is available at runtime.
    3. On Linux, setting ``WM_CLASS`` via the Qt app instance is done
       inside pywebview once the window opens — nothing to do here.

    All of this is a no-op when packaged via PyInstaller with
    ``--name Clinikore`` because the binary itself is already called
    the right thing."""
    try:
        import setproctitle  # type: ignore
        setproctitle.setproctitle(APP_NAME)
    except ImportError:
        pass  # optional dep
    except Exception:  # pragma: no cover - defensive
        pass

    if sys.platform == "darwin":
        try:
            from Foundation import NSBundle  # type: ignore
            bundle = NSBundle.mainBundle()
            info = bundle.localizedInfoDictionary() or bundle.infoDictionary()
            if info is not None:
                info["CFBundleName"] = APP_NAME
                info["CFBundleDisplayName"] = APP_NAME
        except Exception:
            # PyObjC may be missing in stripped dev envs; the Dock
            # will fall back to "Python" but the app still works.
            pass


# Rename the process BEFORE we import anything heavy so the OS picks up
# the new name as early as possible (Activity Monitor polls the name
# within a second of launch).
_set_app_identity()

# Configure logging FIRST (before importing backend.main, so its module-level
# loggers pick up the right handlers).
from backend.logging_setup import configure_logging  # noqa: E402
LOG_DIR = configure_logging()

from backend.main import app  # noqa: E402  (deliberate ordering)

log = logging.getLogger("clinikore")

HOST = "127.0.0.1"


def _windows_version() -> Optional[tuple[int, int, int]]:
    if sys.platform != "win32":
        return None
    getwindowsversion = getattr(sys, "getwindowsversion", None)
    if getwindowsversion is None:
        return None
    version = getwindowsversion()
    return version.major, version.minor, version.build


def _is_legacy_windows() -> bool:
    version = _windows_version()
    if version is None:
        return False
    # Windows 7 is 6.1. Edge WebView2 is no longer supported there, so use
    # the system browser instead of trying to create a native WebView2 window.
    return version[:2] <= (6, 1)


def _find_chrome_exe() -> Optional[str]:
    candidates = []
    for base in (
        os.environ.get("PROGRAMFILES"),
        os.environ.get("PROGRAMFILES(X86)"),
        os.environ.get("LOCALAPPDATA"),
    ):
        if base:
            candidates.append(
                os.path.join(base, "Google", "Chrome", "Application", "chrome.exe")
            )
            candidates.append(
                os.path.join(base, "Chromium", "Application", "chrome.exe")
            )
    for path in candidates:
        if os.path.exists(path):
            return path
    return None


def _open_external_browser(url: str) -> None:
    """Open a browser-backed app window and block while it is running."""
    if sys.platform == "win32":
        chrome = _find_chrome_exe()
        if chrome:
            profile_root = os.environ.get("LOCALAPPDATA") or os.path.expanduser(
                "~\\AppData\\Local"
            )
            profile_dir = os.path.join(profile_root, "Clinikore", "BrowserProfile")
            os.makedirs(profile_dir, exist_ok=True)
            log.info("Opening Chrome app window: %s", chrome)
            proc = subprocess.Popen([
                chrome,
                f"--app={url}",
                "--new-window",
                "--no-first-run",
                f"--user-data-dir={profile_dir}",
            ])
            proc.wait()
            return

    log.warning("Opening default browser; close Clinikore from Task Manager if needed.")
    import webbrowser
    webbrowser.open(url)
    # Keep the embedded backend alive while the browser tab is open. With the
    # stdlib `webbrowser` fallback we cannot observe tab/window close events.
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass


def _find_free_port(default: int = 8765) -> int:
    # Try the default first so bookmarks / dev tooling work; fall back to random.
    for candidate in (default, 0):
        with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as s:
            try:
                s.bind((HOST, candidate))
                return s.getsockname()[1]
            except OSError:
                continue
    raise RuntimeError("Could not bind any port")


class ServerThread(threading.Thread):
    def __init__(self, port: int):
        super().__init__(daemon=True)
        self.port = port
        self.config = uvicorn.Config(
            app=app,
            host=HOST,
            port=port,
            log_level="info",
            access_log=False,
            # log_config=None => don't let uvicorn overwrite the root logger
            # that configure_logging() just set up.
            log_config=None,
        )
        self.server = uvicorn.Server(self.config)

    def run(self) -> None:
        self.server.run()

    def stop(self) -> None:
        self.server.should_exit = True


def _wait_until_ready(port: int, timeout: float = 10.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as s:
            s.settimeout(0.2)
            try:
                s.connect((HOST, port))
                return True
            except OSError:
                time.sleep(0.1)
    return False


def _open_window(url: str) -> None:
    if _is_legacy_windows():
        log.warning("Windows 7 detected; using browser mode instead of WebView2.")
        _open_external_browser(url)
        return

    try:
        import webview  # pywebview
    except ImportError:
        log.warning("pywebview not installed; opening in default browser instead.")
        _open_external_browser(url)
        return

    webview.create_window(
        title="Clinikore",
        url=url,
        width=1280,
        height=820,
        min_size=(1024, 700),
    )

    # Pick a GUI backend per platform. pywebview auto-detects in most cases, but
    # pinning a value avoids "ModuleNotFoundError" when multiple backends are
    # installed and lets packaging be deterministic.
    #   - macOS:    "cocoa"  (built-in WebKit)
    #   - Windows:  "edgechromium" (Edge WebView2 — shipped with Win10+)
    #   - Linux:    "qt" (PyQt5/PySide2) or "gtk" (PyGObject + webkit2gtk)
    gui: Optional[str] = None
    if sys.platform == "darwin":
        gui = "cocoa"
    elif sys.platform == "win32":
        gui = "edgechromium"
    elif sys.platform.startswith("linux"):
        gui = "qt"  # matches the `pywebview[qt]` extra in requirements.txt

    webview.start(gui=gui)


def main() -> None:
    port = _find_free_port(8765)
    url = f"http://{HOST}:{port}"
    log.info("Launcher starting: host=%s port=%d url=%s", HOST, port, url)
    log.info("Log files: %s", LOG_DIR)

    server = ServerThread(port=port)
    server.start()

    if not _wait_until_ready(port):
        log.error("Backend failed to start within 10s")
        sys.exit(1)

    log.info("Backend is up on %s — opening desktop window (gui=%s)",
             url, sys.platform)
    try:
        _open_window(url)
    except Exception:
        log.exception("Desktop window crashed")
    finally:
        log.info("Window closed — shutting down backend...")
        server.stop()
        server.join(timeout=5)
        log.info("Clean exit")


if __name__ == "__main__":
    main()
