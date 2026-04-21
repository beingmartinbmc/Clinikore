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
import socket
import sys
import threading
import time
from contextlib import closing
from typing import Optional

import uvicorn

# Configure logging FIRST (before importing backend.main, so its module-level
# loggers pick up the right handlers).
from backend.logging_setup import configure_logging
LOG_DIR = configure_logging()

from backend.main import app  # noqa: E402  (deliberate ordering)

log = logging.getLogger("clinikore")

HOST = "127.0.0.1"


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
    try:
        import webview  # pywebview
    except ImportError:
        log.warning("pywebview not installed; opening in default browser instead.")
        import webbrowser
        webbrowser.open(url)
        # Block forever so the server thread keeps running.
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            pass
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
