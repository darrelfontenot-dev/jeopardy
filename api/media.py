"""Media files for clues (images, video, audio), stored in a public Supabase Storage bucket.

The browser uploads straight to Storage through a signed URL (Vercel limits request bodies to 4.5 MB),
and playback is a redirect to the bucket's public URL, so video seeking works.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
BUCKET = os.environ.get("MEDIA_BUCKET", "media").strip() or "media"
MAX_BYTES = 50 * 1024 * 1024  # Supabase's free plan caps a single file at 50 MB

KINDS = {
    ".png": "image", ".jpg": "image", ".jpeg": "image", ".gif": "image", ".webp": "image", ".svg": "image",
    ".mp4": "video", ".webm": "video", ".m4v": "video", ".mov": "video",
    ".mp3": "audio", ".wav": "audio", ".m4a": "audio", ".ogg": "audio",
}
_NAME_RE = re.compile(r"^[\w .,&'()+\-]{1,120}$")


class MediaProblem(ValueError):
    """The file name or file is not acceptable."""


def configured() -> bool:
    return bool(SUPABASE_URL and SERVICE_KEY)


def kind(name: str) -> str | None:
    return KINDS.get(Path(name).suffix.lower())


def is_url(ref: str) -> bool:
    return ref.lower().startswith(("http://", "https://"))


def clean_name(raw: str) -> str:
    """The file name as stored: no folders, single spaces, a supported extension."""
    name = re.sub(r"\s+", " ", Path(str(raw or "").replace("\\", "/")).name).strip()
    if not name or not _NAME_RE.match(name) or name.startswith("."):
        raise MediaProblem("File names can use letters, numbers, spaces and . , & ' ( ) + - (up to 120 characters).")
    if not kind(name):
        raise MediaProblem("Supported files: " + ", ".join(sorted(KINDS)) + ".")
    return name


def _api(path: str) -> str:
    return f"{SUPABASE_URL}/storage/v1{path}"


def _headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {SERVICE_KEY}", "apikey": SERVICE_KEY}


def public_url(name: str) -> str:
    return _api(f"/object/public/{BUCKET}/{quote(clean_name(name))}")


def _ensure_bucket(client: httpx.Client) -> None:
    resp = client.post(_api("/bucket"), headers=_headers(), json={"id": BUCKET, "name": BUCKET, "public": True, "file_size_limit": MAX_BYTES})
    # 400/409 means the bucket already exists.
    if resp.status_code >= 500:
        resp.raise_for_status()


def signed_upload(name: str) -> dict[str, str]:
    """A one-time URL the browser can PUT the file to."""
    name = clean_name(name)
    with httpx.Client(timeout=20) as client:
        _ensure_bucket(client)
        resp = client.post(_api(f"/object/upload/sign/{BUCKET}/{quote(name)}"), headers={**_headers(), "x-upsert": "true"})
        if resp.status_code >= 400:
            raise RuntimeError(f"Storage refused the upload: {resp.text[:200]}")
        url = resp.json().get("url", "")
    return {"name": name, "url": _api(url)}


def delete(name: str) -> None:
    name = clean_name(name)
    with httpx.Client(timeout=20) as client:
        resp = client.delete(_api(f"/object/{BUCKET}/{quote(name)}"), headers=_headers())
        if resp.status_code >= 500:
            resp.raise_for_status()


def list_files() -> list[dict[str, Any]]:
    with httpx.Client(timeout=20) as client:
        _ensure_bucket(client)
        resp = client.post(
            _api(f"/object/list/{BUCKET}"), headers=_headers(),
            json={"prefix": "", "limit": 1000, "offset": 0, "sortBy": {"column": "name", "order": "asc"}},
        )
        resp.raise_for_status()
    files = []
    for entry in resp.json():
        name = entry.get("name") or ""
        if not name or not kind(name) or entry.get("id") is None:
            continue
        files.append({"name": name, "size": int((entry.get("metadata") or {}).get("size") or 0), "kind": kind(name)})
    return sorted(files, key=lambda f: f["name"].lower())
