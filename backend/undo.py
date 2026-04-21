"""Tiny in-memory undo buffer.

When a soft-delete happens we stash `(entity_type, entity_id)` under a short
token and return it to the caller. The frontend shows an "Undo" toast that
POSTs back with the token. Tokens expire after 60 seconds and the buffer is
bounded so this is safe for a single-user desktop app.
"""
from __future__ import annotations

import secrets
import threading
import time
from dataclasses import dataclass
from typing import Optional

TOKEN_TTL_SECONDS = 60
MAX_ENTRIES = 64


@dataclass
class UndoEntry:
    token: str
    entity_type: str
    entity_id: int
    # Optional preformatted label for the UI: "Patient Priya Sharma"
    label: str
    expires_at: float


class UndoBuffer:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._entries: dict[str, UndoEntry] = {}

    def push(self, entity_type: str, entity_id: int, label: str = "") -> UndoEntry:
        token = secrets.token_urlsafe(8)
        entry = UndoEntry(
            token=token,
            entity_type=entity_type,
            entity_id=entity_id,
            label=label,
            expires_at=time.time() + TOKEN_TTL_SECONDS,
        )
        with self._lock:
            self._gc_locked()
            self._entries[token] = entry
            if len(self._entries) > MAX_ENTRIES:
                oldest = min(self._entries.values(), key=lambda e: e.expires_at)
                self._entries.pop(oldest.token, None)
        return entry

    def pop(self, token: str) -> Optional[UndoEntry]:
        with self._lock:
            self._gc_locked()
            return self._entries.pop(token, None)

    def _gc_locked(self) -> None:
        now = time.time()
        expired = [t for t, e in self._entries.items() if e.expires_at < now]
        for t in expired:
            self._entries.pop(t, None)


buffer = UndoBuffer()
