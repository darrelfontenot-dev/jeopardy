"""Live game rooms: players join from their own devices and ring in; the host's screen runs the game.

The host's browser stays the referee. This module only relays: buzzes and wagers go from players to the
host in the order the database received them, and the host's (answer-free) view of the game goes back to
the players. State lives in Supabase Postgres, so any serverless instance can serve any request.
Both directions use long polling: a request checks a cheap version counter every fraction of a second
and returns as soon as it changes (or after WAIT_SECONDS, when the client just asks again).
"""

from __future__ import annotations

import secrets
import time

from psycopg.types.json import Jsonb

import db

CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ"  # no I or O, so codes read cleanly off a screen
MAX_PLAYERS = 6
MAX_NAME = 20
ROOM_TTL_SECONDS = 8 * 3600
ONLINE_SECONDS = 25  # a player whose device has not polled for this long shows as offline
WAIT_SECONDS = 15.0
POLL_INTERVAL = 0.3


class RoomProblem(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


class Room:
    def __init__(self, row: dict):
        self.code: str = row["code"]
        self.host_key: str = row["host_key"]
        self.started: bool = row["started"]

    def roster(self) -> list[dict]:
        # Signatures are fetched separately (sigs()) so buzz traffic stays small; sigv says when one changed.
        now = time.time()
        rows = db.fetch_all("SELECT id, name, slot, seen, sigv FROM fj_players WHERE room_code = %s ORDER BY (slot IS NULL), slot, ord", (self.code,))
        return [{"id": r["id"], "name": r["name"], "slot": r["slot"], "online": now - r["seen"] < ONLINE_SECONDS, "sigv": r["sigv"]} for r in rows]

    def sigs(self) -> dict[str, str]:
        rows = db.fetch_all("SELECT id, sig FROM fj_players WHERE room_code = %s AND sig <> ''", (self.code,))
        return {r["id"]: r["sig"] for r in rows}


def _purge() -> None:
    cutoff = time.time() - ROOM_TTL_SECONDS
    db.run("DELETE FROM fj_rooms WHERE touched < %s OR closed", (cutoff,))
    db.run("DELETE FROM fj_feeds WHERE touched < %s", (cutoff,))


def get(code: str) -> Room:
    row = db.fetch_one("SELECT code, host_key, started, closed FROM fj_rooms WHERE code = %s", ((code or "").strip().upper(),))
    if row is None or row["closed"]:
        raise RoomProblem(404, "No game with that code is running. Check the code on the host's screen.")
    return Room(row)


def host_room(code: str, key: str) -> Room:
    room = get(code)
    if not key or not secrets.compare_digest(room.host_key, key):
        raise RoomProblem(403, "This screen is not the host of that game.")
    db.run("UPDATE fj_rooms SET touched = %s WHERE code = %s", (time.time(), room.code))
    return room


def clean_name(raw: str) -> str:
    name = " ".join((raw or "").split())[:MAX_NAME]
    if not name:
        raise RoomProblem(400, "Type your name.")
    return name


def _bump(code: str, *, ver: bool = False, state: bool = False) -> None:
    db.run("UPDATE fj_rooms SET ver = ver + %s, state_ver = state_ver + %s WHERE code = %s", (int(ver), int(state), code))


def _head(code: str) -> dict | None:
    return db.fetch_one("SELECT ver, state_ver, ev_seq, closed FROM fj_rooms WHERE code = %s", (code,))


def _wait(code: str, ready) -> dict | None:
    """Block until ready(head) is true, the room goes away, or the wait runs out. Returns the last head."""
    deadline = time.monotonic() + WAIT_SECONDS
    while True:
        head = _head(code)
        if head is None or head["closed"] or ready(head) or time.monotonic() >= deadline:
            return head
        time.sleep(POLL_INTERVAL)


# ---------------------------------------------------------------------------- host


def create() -> dict:
    _purge()
    key = secrets.token_urlsafe(18)
    while True:
        code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(4))
        row = db.fetch_one(
            "INSERT INTO fj_rooms (code, host_key, touched) VALUES (%s, %s, %s) ON CONFLICT DO NOTHING RETURNING code",
            (code, key, time.time()),
        )
        if row:
            return {"code": code, "hostKey": key}


def restore(code: str, key: str, roster: list[dict]) -> dict:
    """Bring a room back for a resumed game (e.g. after it was purged). Players rejoin by name."""
    code = (code or "").strip().upper()
    existing = db.fetch_one("SELECT code, host_key, started, closed FROM fj_rooms WHERE code = %s", (code,))
    if existing is not None and not existing["closed"]:
        if not secrets.compare_digest(existing["host_key"], key or ""):
            raise RoomProblem(409, "That game code is in use by another host.")
        return {"code": code, "hostKey": existing["host_key"], "restored": False}
    if len(code) != 4 or any(ch not in CODE_ALPHABET for ch in code) or not key:
        raise RoomProblem(400, "That saved game has no valid code.")
    with db.connection() as conn:
        with conn.transaction():
            conn.execute("DELETE FROM fj_rooms WHERE code = %s", (code,))
            conn.execute("INSERT INTO fj_rooms (code, host_key, started, touched) VALUES (%s, %s, true, %s)", (code, key, time.time()))
            for entry in roster[:MAX_PLAYERS]:
                conn.execute(
                    "INSERT INTO fj_players (room_code, id, name, token, slot, seen) VALUES (%s, %s, %s, '', %s, 0)",
                    (code, secrets.token_hex(4), clean_name(entry.get("name", "")), entry.get("slot")),
                )
    return {"code": code, "hostKey": key, "restored": True}


def start(room: Room, order: list[str]) -> list[dict]:
    """Lock the roster for play: the listed player ids become engine players p1, p2, ... in that order."""
    existing = {r["id"] for r in db.fetch_all("SELECT id FROM fj_players WHERE room_code = %s", (room.code,))}
    chosen = [i for i in order if i in existing][:MAX_PLAYERS]
    if not chosen:
        raise RoomProblem(400, "Nobody has joined yet.")
    with db.connection() as conn:
        with conn.transaction():
            conn.execute("DELETE FROM fj_players WHERE room_code = %s AND NOT (id = ANY(%s))", (room.code, chosen))
            for i, pid in enumerate(chosen):
                conn.execute("UPDATE fj_players SET slot = %s WHERE room_code = %s AND id = %s", (f"p{i + 1}", room.code, pid))
            conn.execute("UPDATE fj_rooms SET started = true, ver = ver + 1 WHERE code = %s", (room.code,))
    return room.roster()


def kick(room: Room, player_id: str) -> None:
    db.run("DELETE FROM fj_players WHERE room_code = %s AND id = %s", (room.code, player_id))
    _bump(room.code, ver=True, state=True)


def set_state(room: Room, state: dict) -> None:
    db.run("UPDATE fj_rooms SET state = %s, state_ver = state_ver + 1 WHERE code = %s", (Jsonb(state), room.code))


def close(room: Room) -> None:
    db.run("UPDATE fj_rooms SET closed = true, ver = ver + 1, state_ver = state_ver + 1 WHERE code = %s", (room.code,))


def host_poll(room: Room, since: int, after: int) -> dict:
    """Wait for anything new for the host: events numbered above `after`, or a roster change past `since`."""
    head = _wait(room.code, lambda h: h["ver"] > since)
    if head is None:
        raise RoomProblem(404, "This game has ended.")
    # Keep only recent events; the host acknowledges by passing the last seq it handled.
    if after > 50:
        db.run("DELETE FROM fj_events WHERE room_code = %s AND seq <= %s", (room.code, after - 50))
    events = db.fetch_all("SELECT seq, t, pid, value, data FROM fj_events WHERE room_code = %s AND seq > %s ORDER BY seq", (room.code, after))
    out = []
    for e in events:
        item = {"seq": e["seq"], "t": e["t"], "pid": e["pid"], "value": e["value"]}
        if e["data"] is not None:
            item["data"] = e["data"]
        out.append(item)
    return {"ver": head["ver"], "seq": head["ev_seq"], "players": room.roster(), "events": out}


# ---------------------------------------------------------------------------- players


def _player(room: Room, token: str) -> dict:
    row = db.fetch_one("SELECT id, name, slot, seen, sig FROM fj_players WHERE room_code = %s AND token = %s", (room.code, token)) if token else None
    if row is None:
        raise RoomProblem(403, "You are not in this game. Join again.")
    return row


def _seen(room: Room, player_id: str) -> None:
    db.run("UPDATE fj_players SET seen = %s WHERE room_code = %s AND id = %s", (time.time(), room.code, player_id))


def join(room: Room, name: str, token: str | None) -> dict:
    name = clean_name(name)
    if token:
        row = db.fetch_one("SELECT id, name, token FROM fj_players WHERE room_code = %s AND token = %s", (room.code, token))
        if row:
            if not room.started:
                db.run("UPDATE fj_players SET name = %s WHERE room_code = %s AND id = %s", (name, room.code, row["id"]))
            _seen(room, row["id"])
            _bump(room.code, ver=True)
            current = db.fetch_one("SELECT id, name, token FROM fj_players WHERE room_code = %s AND id = %s", (room.code, row["id"]))
            return {"token": current["token"], "id": current["id"], "name": current["name"]}
    taken = db.fetch_one("SELECT id, name FROM fj_players WHERE room_code = %s AND lower(name) = lower(%s)", (room.code, name))
    if room.started:
        # Once play starts the podiums are fixed; a player on a new device takes back their own seat by name.
        if taken is None:
            raise RoomProblem(409, "This game has already started. Ask the host to add you next game.")
        new_token = secrets.token_urlsafe(18)
        db.run("UPDATE fj_players SET token = %s, seen = %s WHERE room_code = %s AND id = %s", (new_token, time.time(), room.code, taken["id"]))
        _bump(room.code, ver=True)
        return {"token": new_token, "id": taken["id"], "name": taken["name"]}
    if taken is not None:
        raise RoomProblem(409, f'Someone called "{taken["name"]}" has already joined. Add an initial or a nickname.')
    count = db.fetch_one("SELECT count(*) AS n FROM fj_players WHERE room_code = %s", (room.code,))["n"]
    if count >= MAX_PLAYERS:
        raise RoomProblem(409, f"This game is full ({MAX_PLAYERS} players).")
    pid, new_token = secrets.token_hex(4), secrets.token_urlsafe(18)
    db.run("INSERT INTO fj_players (room_code, id, name, token, seen) VALUES (%s, %s, %s, %s, %s)", (room.code, pid, name, new_token, time.time()))
    _bump(room.code, ver=True, state=True)
    return {"token": new_token, "id": pid, "name": name}


def player_poll(room: Room, token: str, since: int) -> dict:
    p = _player(room, token)
    was_offline = time.time() - p["seen"] >= ONLINE_SECONDS
    _seen(room, p["id"])
    if was_offline:
        _bump(room.code, ver=True)
    head = _wait(room.code, lambda h: h["state_ver"] > since)
    if head is None or head["closed"]:
        raise RoomProblem(404, "The host has ended this game.")
    p = _player(room, token)
    _seen(room, p["id"])
    state_row = db.fetch_one("SELECT state, started FROM fj_rooms WHERE code = %s", (room.code,))
    return {
        "ver": head["state_ver"],
        "me": {"id": p["id"], "name": p["name"], "slot": p["slot"], "sig": p["sig"]},
        "started": state_row["started"] if state_row else False,
        "players": room.roster(),
        "state": state_row["state"] if state_row else None,
    }


def send(room: Room, token: str, kind: str, value: int | None = None, data: dict | None = None) -> None:
    p = _player(room, token)
    _seen(room, p["id"])
    if not p["slot"]:
        raise RoomProblem(409, "The game has not started yet.")
    with db.connection() as conn:
        with conn.transaction():
            seq = conn.execute("UPDATE fj_rooms SET ev_seq = ev_seq + 1, ver = ver + 1 WHERE code = %s RETURNING ev_seq", (room.code,)).fetchone()["ev_seq"]
            conn.execute(
                "INSERT INTO fj_events (room_code, seq, t, pid, value, data) VALUES (%s, %s, %s, %s, %s, %s)",
                (room.code, seq, kind, p["slot"], value, Jsonb(data) if data is not None else None),
            )


SIG_PREFIX = "data:image/png;base64,"
MAX_SIG_CHARS = 120_000
MAX_RESPONSE_TEXT = 200


def final_response(room: Room, token: str, text: str, ink: str) -> None:
    """A Final Jeopardy response, typed or handwritten. It goes only to the host's screen."""
    text = " ".join((text or "").split())[:MAX_RESPONSE_TEXT]
    ink = ink or ""
    if ink and (not ink.startswith(SIG_PREFIX) or len(ink) > MAX_SIG_CHARS):
        raise RoomProblem(400, "That handwriting could not be sent. Try writing a bit smaller.")
    if not text and not ink:
        raise RoomProblem(400, "Type or write your response first.")
    send(room, token, "fresp", data={"text": "" if ink else text, "ink": ink})


def sign(room: Room, token: str, sig: str) -> None:
    """Store (or clear, with an empty string) a player's handwritten name."""
    p = _player(room, token)
    if sig and (not sig.startswith(SIG_PREFIX) or len(sig) > MAX_SIG_CHARS):
        raise RoomProblem(400, "That signature could not be saved. Try writing it a bit smaller.")
    db.run("UPDATE fj_players SET sig = %s, sigv = sigv + 1, seen = %s WHERE room_code = %s AND id = %s", (sig or "", time.time(), room.code, p["id"]))
    _bump(room.code, ver=True, state=True)
