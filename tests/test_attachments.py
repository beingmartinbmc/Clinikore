"""Consultation attachments API tests.

Doctors can pin images / PDFs / Word docs to a specific consultation note.
Files land on disk under ``APP_DIR/attachments/<note_id>/`` with a uuid
filename; the DB only carries metadata + a relative path. These tests
cover:

* Upload roundtrip (metadata comes back, file is on disk, download works).
* MIME-type validation rejects disallowed types (e.g. arbitrary binaries).
* List endpoint returns uploads in order.
* Soft-delete + best-effort disk cleanup.
* Path-traversal hardening: storage paths never escape APP_DIR.
"""
from __future__ import annotations

import io
from pathlib import Path

from backend.db import APP_DIR, ATTACHMENTS_DIR


def _setup_note(client) -> tuple[int, int]:
    """Create patient + consultation note, return (patient_id, note_id)."""
    p = client.post("/api/patients", json={"name": "Arjun Verma"}).json()
    n = client.post(
        "/api/consultation-notes",
        json={"patient_id": p["id"], "chief_complaint": "Fever"},
    ).json()
    return p["id"], n["id"]


def test_upload_and_download_roundtrip(client):
    _, nid = _setup_note(client)
    payload = b"%PDF-1.4\n%hello"
    r = client.post(
        f"/api/consultation-notes/{nid}/attachments",
        files={"file": ("report.pdf", io.BytesIO(payload), "application/pdf")},
        data={"caption": "CBC report"},
    )
    assert r.status_code == 201, r.text
    a = r.json()
    assert a["filename"] == "report.pdf"
    assert a["mime_type"] == "application/pdf"
    assert a["kind"] == "pdf"
    assert a["size_bytes"] == len(payload)
    assert a["caption"] == "CBC report"
    assert a["download_url"] == f"/api/attachments/{a['id']}/file"

    # File must actually be on disk under APP_DIR.
    note_dir = ATTACHMENTS_DIR / str(nid)
    assert note_dir.is_dir(), "note-scoped folder was not created"
    files = list(note_dir.iterdir())
    assert len(files) == 1
    assert files[0].read_bytes() == payload

    # Download route streams the bytes back with the correct mime type.
    r = client.get(a["download_url"])
    assert r.status_code == 200
    assert r.content == payload
    assert r.headers["content-type"].startswith("application/pdf")


def test_upload_rejects_disallowed_mime_type(client):
    _, nid = _setup_note(client)
    # Arbitrary executables must never be stored -- the endpoint is a
    # health-record sink, not a general-purpose file server.
    r = client.post(
        f"/api/consultation-notes/{nid}/attachments",
        files={
            "file": (
                "malware.bin", io.BytesIO(b"\x00\x01\x02"),
                "application/x-msdownload",
            ),
        },
    )
    assert r.status_code == 415, r.text


def test_image_uploads_are_classified_as_image(client):
    _, nid = _setup_note(client)
    # 1x1 red PNG; content doesn't matter, the classifier only checks mime.
    png = (
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
        b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\x9cc\xfc\xff"
        b"\xff?\x03\x00\x06\x05\x02\x01\xb0\xd1\xd5\xf4\x00\x00\x00\x00IEND"
        b"\xaeB`\x82"
    )
    r = client.post(
        f"/api/consultation-notes/{nid}/attachments",
        files={"file": ("xray.png", io.BytesIO(png), "image/png")},
    )
    assert r.status_code == 201, r.text
    assert r.json()["kind"] == "image"


def test_common_image_formats_are_accepted(client):
    """PNG, JPEG, HEIC and HEIF are all expected first-class formats because
    iPhones shoot HEIC by default and most Android/DSLR output is JPEG."""
    _, nid = _setup_note(client)
    cases = [
        ("photo.jpg",  "image/jpeg"),
        ("photo.jpeg", "image/jpeg"),
        ("scan.png",   "image/png"),
        ("clinical.heic", "image/heic"),
        ("clinical.heif", "image/heif"),
        ("xray.webp",  "image/webp"),
    ]
    for name, mime in cases:
        r = client.post(
            f"/api/consultation-notes/{nid}/attachments",
            files={"file": (name, io.BytesIO(b"fake"), mime)},
        )
        assert r.status_code == 201, f"{name}/{mime} rejected: {r.text}"
        body = r.json()
        assert body["kind"] == "image", f"{name} classified as {body['kind']}"
        assert body["mime_type"] == mime


def test_heic_upload_without_mime_is_rescued_by_extension(client):
    """Windows Chromium uploads HEIC as application/octet-stream because it
    doesn't know the type. We fall back to the filename extension so the
    file is still accepted and ends up correctly classified as an image."""
    _, nid = _setup_note(client)
    r = client.post(
        f"/api/consultation-notes/{nid}/attachments",
        files={
            "file": (
                "iphone_xray.heic", io.BytesIO(b"fake-heic"),
                "application/octet-stream",
            ),
        },
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["mime_type"] == "image/heic"
    assert body["kind"] == "image"


def test_svg_is_rejected_even_though_it_is_technically_an_image(client):
    """SVGs are XML and can carry <script>, so we don't accept them as
    health-record attachments. Guard against accidental allow-listing."""
    _, nid = _setup_note(client)
    r = client.post(
        f"/api/consultation-notes/{nid}/attachments",
        files={
            "file": (
                "evil.svg",
                io.BytesIO(b"<svg onload='alert(1)'/>"),
                "image/svg+xml",
            ),
        },
    )
    assert r.status_code == 415, r.text


def test_list_returns_uploaded_attachments(client):
    _, nid = _setup_note(client)
    for name in ("a.pdf", "b.pdf"):
        client.post(
            f"/api/consultation-notes/{nid}/attachments",
            files={"file": (name, io.BytesIO(b"x"), "application/pdf")},
        )
    r = client.get(f"/api/consultation-notes/{nid}/attachments")
    assert r.status_code == 200
    names = [a["filename"] for a in r.json()]
    assert names == ["a.pdf", "b.pdf"]


def test_delete_attachment_soft_deletes_and_hides_from_list(client):
    _, nid = _setup_note(client)
    created = client.post(
        f"/api/consultation-notes/{nid}/attachments",
        files={"file": ("x.pdf", io.BytesIO(b"abc"), "application/pdf")},
    ).json()
    aid = created["id"]

    r = client.delete(f"/api/attachments/{aid}")
    assert r.status_code == 204

    r = client.get(f"/api/consultation-notes/{nid}/attachments")
    assert r.json() == []

    # File should be unlinked best-effort; if it isn't (e.g. platform quirk)
    # we still want the API to behave correctly, so only assert the metadata.
    r = client.get(f"/api/attachments/{aid}/file")
    assert r.status_code == 404


def test_attachments_fail_on_unknown_note(client):
    r = client.post(
        "/api/consultation-notes/999999/attachments",
        files={"file": ("x.pdf", io.BytesIO(b"x"), "application/pdf")},
    )
    assert r.status_code == 404


def test_filename_is_sanitised_against_path_traversal(client):
    _, nid = _setup_note(client)
    r = client.post(
        f"/api/consultation-notes/{nid}/attachments",
        files={
            "file": (
                "../../../../etc/passwd", io.BytesIO(b"root:x:0:0"),
                "text/plain",
            ),
        },
    )
    assert r.status_code == 201, r.text
    saved = r.json()
    # Display filename is the last path component only -- no parent refs.
    assert saved["filename"] == "passwd"
    # Stored file must live under APP_DIR.
    stored = Path(APP_DIR) / "attachments" / str(nid)
    files = [p for p in stored.iterdir() if p.is_file()]
    assert len(files) >= 1
    for f in files:
        f.resolve().relative_to(Path(APP_DIR).resolve())  # raises if outside
