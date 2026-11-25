"""Christmas Jeopardy API (FastAPI on Vercel, data in Supabase). The front end is static files in ../public."""

from __future__ import annotations

import logging
import os
import re
import secrets
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import anyio.to_thread  # noqa: E402
from fastapi import FastAPI, HTTPException, Query, Request  # noqa: E402
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from starlette.concurrency import run_in_threadpool  # noqa: E402

import importer  # noqa: E402
import media  # noqa: E402
import modfeed  # noqa: E402
import rooms  # noqa: E402
import store  # noqa: E402

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("christmas-jeopardy")

PUBLIC_DIR = Path(__file__).resolve().parent.parent / "public"
MAX_UPLOAD_BYTES = 4 * 1024 * 1024  # Vercel rejects request bodies over 4.5 MB
GAME_ID_RE = re.compile(r"^[\w .&'()\-]{1,60}$")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
LOCAL_DEV = os.environ.get("LOCAL_DEV", "").lower() in {"1", "true", "yes"}
# Default Final Jeopardy music: an uploaded media file name or a link ("" = built-in loop).
THINK_MUSIC = os.environ.get("THINK_MUSIC", "Final Jeopardy.mp3").strip()

app = FastAPI(title="Christmas Jeopardy", docs_url=None, redoc_url=None)


async def _call(fn, *args):
    """Run blocking database work off the event loop (long polls hold a thread while they wait)."""
    limiter = anyio.to_thread.current_default_thread_limiter()
    if limiter.total_tokens < 200:
        limiter.total_tokens = 200
    return await run_in_threadpool(fn, *args)


def is_admin(request: Request) -> bool:
    if LOCAL_DEV:
        return True
    supplied = request.headers.get("x-admin-key", "")
    return bool(ADMIN_PASSWORD) and secrets.compare_digest(supplied.encode(), ADMIN_PASSWORD.encode())


def require_admin(request: Request) -> str:
    if not is_admin(request):
        raise HTTPException(status_code=403, detail="Only the question manager can change question sets. Check the admin password.")
    return "admin"


def _game_id(raw: str) -> str:
    game_id = raw.strip()
    if not GAME_ID_RE.match(game_id):
        raise HTTPException(status_code=400, detail="Question set names can use letters, numbers, spaces and . & ' ( ) -")
    if game_id.lower() == store.SAMPLE_ID:
        raise HTTPException(status_code=400, detail='"sample" is reserved for the built-in board.')
    return game_id


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/me")
def me(request: Request) -> dict:
    admin = is_admin(request)
    return {
        "user": "", "isAdmin": admin, "adminConfigured": bool(ADMIN_PASSWORD) or LOCAL_DEV,
        "canStore": store.database_configured(), "canStoreMedia": media.configured(), "thinkMusic": THINK_MUSIC,
    }


@app.get("/api/games")
def games(refresh: bool = Query(False)) -> JSONResponse:
    return JSONResponse(store.list_games(), headers={"Cache-Control": "no-store"})


@app.get("/api/games/{game_id}")
def game(game_id: str) -> JSONResponse:
    try:
        found = store.get_game(game_id)
    except Exception as exc:  # noqa: BLE001
        log.exception("loading game %s failed", game_id)
        raise HTTPException(status_code=502, detail="The question table could not be read.") from exc
    if found is None:
        raise HTTPException(status_code=404, detail="That question set does not exist.")
    return JSONResponse(found, headers={"Cache-Control": "no-store"})


@app.get("/api/admin/template")
def template() -> Response:
    return Response(
        importer.build_template(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="christmas-jeopardy-template.xlsx"'},
    )


@app.post("/api/admin/import")
async def import_questions(
    request: Request,
    game_id: str = Query(..., description="Name of the question set to create or replace"),
    filename: str = Query("upload.xlsx"),
) -> dict:
    user = require_admin(request)
    name = _game_id(game_id)
    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="The file is empty.")
    if len(body) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="The file is larger than 4 MB.")
    try:
        rows, warnings = importer.parse_upload(body, filename, name)
    except importer.ImportProblem as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    # A "Game" column in the file may split it into several sets.
    by_game: dict[str, list[dict]] = {}
    for row in rows:
        by_game.setdefault(_game_id(row["game_id"]), []).append(row)
    warnings += await _call(_check_media, rows)
    try:
        for set_name, set_rows in by_game.items():
            warnings += await _call(store.replace_game, set_name, set_rows, user)
    except Exception as exc:  # noqa: BLE001
        log.exception("importing questions failed")
        raise HTTPException(status_code=502, detail=f"Saving to the question table failed: {exc}") from exc
    return {"imported": {k: len(v) for k, v in by_game.items()}, "warnings": warnings[:50]}


@app.delete("/api/admin/games/{game_id}")
def delete_game(game_id: str, request: Request) -> dict:
    require_admin(request)
    name = _game_id(game_id)
    try:
        store.delete_game(name)
    except Exception as exc:  # noqa: BLE001
        log.exception("deleting %s failed", name)
        raise HTTPException(status_code=502, detail="Deleting from the question table failed.") from exc
    return {"deleted": name}


def _check_media(rows: list[dict]) -> list[str]:
    """Point Media cells at the uploaded file (ignoring case) and report the ones that will not show."""
    refs = [(r, key) for r in rows for key in ("media", "answer_media") if r.get(key) and not media.is_url(r[key])]
    if not refs:
        return []
    if not media.configured():
        return ["This app has no media storage, so the Media columns will not show (set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)."]
    try:
        known = {f["name"].lower(): f["name"] for f in media.list_files()}
    except Exception:  # noqa: BLE001
        log.exception("listing media failed")
        return ["Could not check the Media columns against the uploaded media files."]
    missing: list[str] = []
    for row, key in refs:
        name = known.get(row[key].strip().lower())
        if name:
            row[key] = name
        elif row[key] not in missing:
            missing.append(row[key])
    if not missing:
        return []
    shown = ", ".join(missing[:10]) + (" ..." if len(missing) > 10 else "")
    return [f"Media files not uploaded yet (upload them under Media files before playing): {shown}"]


@app.get("/api/admin/media")
def list_media(request: Request) -> dict:
    require_admin(request)
    if not media.configured():
        return {"files": [], "configured": False}
    try:
        return {"files": media.list_files(), "configured": True}
    except Exception as exc:  # noqa: BLE001
        log.exception("listing media failed")
        raise HTTPException(status_code=502, detail="The media bucket could not be read.") from exc


@app.post("/api/admin/media/sign")
def sign_media_upload(request: Request, filename: str = Query(...), size: int = Query(0)) -> dict:
    """Give the browser a one-time URL so it uploads the file straight to Supabase Storage."""
    require_admin(request)
    if not media.configured():
        raise HTTPException(status_code=503, detail="Media storage is not set up (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).")
    if size > media.MAX_BYTES:
        raise HTTPException(status_code=413, detail="The file is larger than 50 MB.")
    try:
        return media.signed_upload(filename)
    except media.MediaProblem as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        log.exception("signing upload %s failed", filename)
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.delete("/api/admin/media/{name}")
def delete_media(name: str, request: Request) -> dict:
    require_admin(request)
    try:
        media.delete(name)
    except media.MediaProblem as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        log.exception("deleting media %s failed", name)
        raise HTTPException(status_code=502, detail="Deleting the file failed.") from exc
    return {"deleted": name}


@app.get("/api/media/{name}")
def get_media(name: str) -> RedirectResponse:
    if not media.configured():
        raise HTTPException(status_code=404, detail="Media storage is not set up.")
    try:
        return RedirectResponse(media.public_url(name), status_code=302, headers={"Cache-Control": "public, max-age=300"})
    except media.MediaProblem as exc:
        raise HTTPException(status_code=404, detail="That media file does not exist.") from exc


# ---------------------------------------------------------------------------- live rooms (player buzzers)


@app.exception_handler(rooms.RoomProblem)
async def room_problem(_: Request, exc: rooms.RoomProblem) -> JSONResponse:
    return JSONResponse({"detail": str(exc)}, status_code=exc.status)


async def _json(request: Request) -> dict:
    try:
        body = await request.json()
    except ValueError:
        body = None
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Expected a JSON object.")
    return body


NO_STORE = {"Cache-Control": "no-store"}


@app.post("/api/rooms")
async def room_create() -> dict:
    return await _call(rooms.create)


@app.post("/api/rooms/{code}/restore")
async def room_restore(code: str, request: Request) -> dict:
    body = await _json(request)
    roster = body.get("roster") if isinstance(body.get("roster"), list) else []
    return await _call(rooms.restore, code, str(body.get("hostKey", "")), [r for r in roster if isinstance(r, dict)])


@app.get("/api/rooms/{code}/host")
async def room_host_poll(code: str, key: str = Query(...), since: int = Query(-1), after: int = Query(0)) -> JSONResponse:
    def work() -> dict:
        return rooms.host_poll(rooms.host_room(code, key), since, after)

    return JSONResponse(await _call(work), headers=NO_STORE)


@app.post("/api/rooms/{code}/start")
async def room_start(code: str, request: Request, key: str = Query(...)) -> dict:
    body = await _json(request)
    order = [str(i) for i in body.get("order", []) if isinstance(i, str)]
    return {"players": await _call(lambda: rooms.start(rooms.host_room(code, key), order))}


@app.post("/api/rooms/{code}/kick")
async def room_kick(code: str, request: Request, key: str = Query(...)) -> dict:
    body = await _json(request)
    await _call(lambda: rooms.kick(rooms.host_room(code, key), str(body.get("id", ""))))
    return {"ok": True}


@app.post("/api/rooms/{code}/state")
async def room_state(code: str, request: Request, key: str = Query(...)) -> dict:
    body = await _json(request)
    if len(str(body)) > 20000:
        raise HTTPException(status_code=413, detail="State too large.")
    await _call(lambda: rooms.set_state(rooms.host_room(code, key), body))
    return {"ok": True}


@app.delete("/api/rooms/{code}")
async def room_close(code: str, key: str = Query(...)) -> dict:
    await _call(lambda: rooms.close(rooms.host_room(code, key)))
    return {"ok": True}


@app.post("/api/rooms/{code}/join")
async def room_join(code: str, request: Request) -> dict:
    body = await _json(request)
    token = body.get("token")
    return await _call(lambda: rooms.join(rooms.get(code), str(body.get("name", "")), token if isinstance(token, str) else None))


@app.get("/api/rooms/{code}/player")
async def room_player_poll(code: str, token: str = Query(...), since: int = Query(-1)) -> JSONResponse:
    return JSONResponse(await _call(lambda: rooms.player_poll(rooms.get(code), token, since)), headers=NO_STORE)


@app.post("/api/rooms/{code}/buzz")
async def room_buzz(code: str, request: Request) -> dict:
    body = await _json(request)
    await _call(lambda: rooms.send(rooms.get(code), str(body.get("token", "")), "buzz"))
    return {"ok": True}


@app.post("/api/rooms/{code}/sign")
async def room_sign(code: str, request: Request) -> dict:
    body = await _json(request)
    await _call(lambda: rooms.sign(rooms.get(code), str(body.get("token", "")), str(body.get("sig") or "")))
    return {"ok": True}


@app.get("/api/rooms/{code}/sigs")
async def room_sigs(code: str, key: str = Query(...)) -> JSONResponse:
    return JSONResponse(await _call(lambda: rooms.host_room(code, key).sigs()), headers=NO_STORE)


@app.post("/api/rooms/{code}/wager")
async def room_wager(code: str, request: Request) -> dict:
    body = await _json(request)
    try:
        amount = int(body.get("amount"))
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="Type a whole-dollar wager.") from exc
    await _call(lambda: rooms.send(rooms.get(code), str(body.get("token", "")), "fwager", amount))
    return {"ok": True}


@app.post("/api/rooms/{code}/response")
async def room_final_response(code: str, request: Request) -> dict:
    body = await _json(request)
    await _call(lambda: rooms.final_response(rooms.get(code), str(body.get("token", "")), str(body.get("text") or ""), str(body.get("ink") or "")))
    return {"ok": True}


# ---------------------------------------------------------------------------- moderator answer feed


@app.exception_handler(modfeed.FeedProblem)
async def feed_problem(_: Request, exc: modfeed.FeedProblem) -> JSONResponse:
    return JSONResponse({"detail": str(exc)}, status_code=exc.status)


@app.post("/api/mod")
async def mod_open(request: Request) -> dict:
    body = await _json(request)
    return await _call(modfeed.open_feed, str(body.get("id") or ""), str(body.get("hostKey") or ""), str(body.get("viewKey") or ""))


@app.post("/api/mod/{fid}/state")
async def mod_state(fid: str, request: Request, key: str = Query(...)) -> dict:
    body = await _json(request)
    if len(str(body)) > modfeed.MAX_STATE_CHARS:
        raise HTTPException(status_code=413, detail="State too large.")
    await _call(lambda: modfeed.set_state(modfeed.host_feed(fid, key), body))
    return {"ok": True}


@app.get("/api/mod/{fid}")
async def mod_poll(fid: str, view: str = Query(...), since: int = Query(-1)) -> JSONResponse:
    return JSONResponse(await _call(lambda: modfeed.poll(modfeed.view_feed(fid, view), since)), headers=NO_STORE)


# ---------------------------------------------------------------------------- local development only
# On Vercel the files in public/ are served by the CDN before a request reaches this app.

if PUBLIC_DIR.is_dir():

    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(PUBLIC_DIR / "index.html", headers={"Cache-Control": "no-cache"})

    class RevalidatedStatic(StaticFiles):
        def file_response(self, *args, **kwargs):
            response = super().file_response(*args, **kwargs)
            response.headers["Cache-Control"] = "no-cache"
            return response

    app.mount("/static", RevalidatedStatic(directory=PUBLIC_DIR / "static"), name="static")
