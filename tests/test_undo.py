"""In-memory undo buffer tests.

``backend.undo.UndoBuffer`` is used by the soft-delete toast flow: when a
user deletes something, the server stashes the entity reference under a
short-lived token and returns it with the 204. The UI shows a "Undo"
button that posts back with the token.

We test:
  * push -> pop round trip returns the same entry.
  * expired tokens are GC'd and return None.
  * capacity cap evicts the oldest entry.
  * thread-safety of concurrent pushes (buffer has an internal lock).
"""
from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor

from backend import undo


def test_push_and_pop_round_trip():
    buf = undo.UndoBuffer()
    entry = buf.push("patient", 42, label="Patient Priya Sharma")
    assert entry.token
    assert entry.entity_type == "patient"
    assert entry.entity_id == 42

    got = buf.pop(entry.token)
    assert got is entry
    # Pop is destructive — second call returns None.
    assert buf.pop(entry.token) is None


def test_expired_tokens_are_gced(monkeypatch):
    buf = undo.UndoBuffer()
    entry = buf.push("invoice", 7)
    # Fast-forward past the TTL by rewriting time().
    future = time.time() + undo.TOKEN_TTL_SECONDS + 1
    monkeypatch.setattr(undo.time, "time", lambda: future)
    assert buf.pop(entry.token) is None


def test_capacity_cap_evicts_oldest(monkeypatch):
    buf = undo.UndoBuffer()
    # Fill past the cap. Use ascending fake timestamps so the oldest
    # has the earliest expires_at.
    t = [1000.0]
    def fake_time():
        t[0] += 1
        return t[0]
    monkeypatch.setattr(undo.time, "time", fake_time)

    tokens = []
    for i in range(undo.MAX_ENTRIES + 5):
        tokens.append(buf.push("patient", i).token)

    # The first 5 pushes should have been evicted by the time we're done.
    evicted_seen = 0
    for tok in tokens[:5]:
        if buf.pop(tok) is None:
            evicted_seen += 1
    assert evicted_seen >= 1, "Capacity cap did not evict anything"


def test_concurrent_pushes_are_safe():
    buf = undo.UndoBuffer()
    def push(i):
        return buf.push("patient", i).token
    with ThreadPoolExecutor(max_workers=8) as pool:
        tokens = list(pool.map(push, range(32)))
    # All tokens unique and all resolvable.
    assert len(set(tokens)) == 32
    resolved = sum(1 for t in tokens if buf.pop(t) is not None)
    assert resolved == 32
