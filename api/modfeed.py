"""Moderator answer feed: the game screen pushes the current clue and its answer; a moderator's device shows it.

A feed is separate from player rooms so answers never reach the players. The game screen holds the host key
(to push), and the moderator link carries the view key (to read). Feeds live in Postgres; the game screen
recreates its feed with the same keys if it was purged, so a moderator link keeps working.
"""

from __future__ import annotations

import re
import secrets
import time

from psycopg.types.json import Jsonb

import db

WAIT_SECONDS = 15.0
POLL_INTERVAL = 0.3
MAX_STATE_CHARS = 400000
KEY_RE = re.compile(r"^[A-Za-z0-9_\-]{12,64}$")
MAX_QUEUED = 30
# Commands a moderator's device may send to the game screen.
COMMANDS = {
    "advance", "open", "buzz", "judge", "skip", "wager", "select", "control", "undo",
    "endRound", "adjust", "finalWager", "finalAnswer", "media",
}
_migrated = False


def _migrate() -> None:
    global _migrated
    if not _migrated:
        db.run("ALTER TABLE fj_feeds ADD COLUMN IF NOT EXISTS cmds jsonb NOT NULL DEFAULT '[]'::jsonb")
        db.run("ALTER TABLE fj_feeds ADD COLUMN IF NOT EXISTS cseq int NOT NULL DEFAULT 0")
        _migrated = True


class FeedProblem(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def _keys(row: dict) -> dict:
    return {"id": row["id"], "hostKey": row["host_key"], "viewKey": row["view_key"]}


def open_feed(fid: str = "", host_key: str = "", view_key: str = "") -> dict:
    """Return the caller's feed, recreating it with the same keys if it was purged, or make a new one."""
    _migrate()
    row = db.fetch_one("SELECT id, host_key, view_key FROM fj_feeds WHERE id = %s", (fid or "",))
    if row is not None:
        if not secrets.compare_digest(row["host_key"], host_key or ""):
            raise FeedProblem(403, "This screen does not own that moderator feed.")
        db.run("UPDATE fj_feeds SET touched = %s WHERE id = %s", (time.time(), fid))
        return _keys(row)
    if all(KEY_RE.match(k or "") for k in (fid, host_key, view_key)):
        new = {"id": fid, "host_key": host_key, "view_key": view_key}
    else:
        new = {"id": secrets.token_urlsafe(9), "host_key": secrets.token_urlsafe(18), "view_key": secrets.token_urlsafe(18)}
    db.run(
        "INSERT INTO fj_feeds (id, host_key, view_key, touched) VALUES (%s, %s, %s, %s) ON CONFLICT DO NOTHING",
        (new["id"], new["host_key"], new["view_key"], time.time()),
    )
    return _keys(new)


def _get(fid: str) -> dict:
    row = db.fetch_one("SELECT id, host_key, view_key FROM fj_feeds WHERE id = %s", (fid or "",))
    if row is None:
        raise FeedProblem(404, "The game screen is not connected. Open the game, then reload this page.")
    return row


def host_feed(fid: str, key: str) -> dict:
    feed = _get(fid)
    if not key or not secrets.compare_digest(feed["host_key"], key):
        raise FeedProblem(403, "This screen does not own that moderator feed.")
    return feed


def view_feed(fid: str, key: str) -> dict:
    feed = _get(fid)
    if not key or not secrets.compare_digest(feed["view_key"], key):
        raise FeedProblem(403, "This moderator link is not valid. Copy it again from the game menu.")
    return feed


def set_state(feed: dict, state: dict) -> None:
    db.run("UPDATE fj_feeds SET state = %s, ver = ver + 1, touched = %s WHERE id = %s", (Jsonb(state), time.time(), feed["id"]))


def poll(feed: dict, since: int) -> dict:
    deadline = time.monotonic() + WAIT_SECONDS
    while True:
        row = db.fetch_one("SELECT ver FROM fj_feeds WHERE id = %s", (feed["id"],))
        if row is None or row["ver"] > since or time.monotonic() >= deadline:
            break
        time.sleep(POLL_INTERVAL)
    row = db.fetch_one("SELECT ver, state FROM fj_feeds WHERE id = %s", (feed["id"],))
    if row is None:
        raise FeedProblem(404, "The game screen is not connected. Open the game, then reload this page.")
    return {"ver": row["ver"], "state": row["state"]}


def push_command(feed: dict, name: str, args: list) -> None:
    if name not in COMMANDS:
        raise FeedProblem(400, "Unknown command.")
    if not isinstance(args, list) or len(args) > 3 or not all(isinstance(a, (str, int, float, bool)) and len(str(a)) <= 40 for a in args):
        raise FeedProblem(400, "Bad command arguments.")
    _migrate()
    with db.connection() as conn:
        with conn.transaction():
            row = conn.execute("SELECT cmds, cseq FROM fj_feeds WHERE id = %s FOR UPDATE", (feed["id"],)).fetchone()
            seq = row["cseq"] + 1
            cmds = (row["cmds"] or [])[-(MAX_QUEUED - 1):] + [{"n": seq, "name": name, "args": args}]
            conn.execute("UPDATE fj_feeds SET cmds = %s, cseq = %s WHERE id = %s", (Jsonb(cmds), seq, feed["id"]))


def poll_commands(feed: dict, since: int) -> dict:
    """Commands newer than `since`. A negative `since` only reports the current sequence number."""
    _migrate()
    deadline = time.monotonic() + WAIT_SECONDS
    while True:
        row = db.fetch_one("SELECT cseq, cmds FROM fj_feeds WHERE id = %s", (feed["id"],))
        if row is None:
            raise FeedProblem(404, "The moderator feed is gone.")
        if since < 0 or row["cseq"] > since or time.monotonic() >= deadline:
            break
        time.sleep(POLL_INTERVAL)
    cmds = [] if since < 0 else [c for c in (row["cmds"] or []) if c["n"] > since]
    return {"seq": row["cseq"], "cmds": cmds}
