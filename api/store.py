"""Question storage in Supabase Postgres, with a built-in sample set.

If no database is configured (or it cannot be read) the sample set is served and the response says so,
so the UI never pretends the sample is real data.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

import db

log = logging.getLogger("christmas-jeopardy")

BASE_DIR = Path(__file__).resolve().parent
SAMPLE_ID = "sample"
SOURCE = "supabase"


def database_configured() -> bool:
    return db.configured()


# ---------------------------------------------------------------------------------------------
# Board assembly
# ---------------------------------------------------------------------------------------------

def build_game(game_id: str, rows: list[dict[str, Any]], source: str) -> dict[str, Any]:
    """Group flat clue rows into rounds -> categories -> clues (the shape the front end plays)."""
    ordered = sorted(rows, key=lambda r: (r.get("sort_order") if r.get("sort_order") is not None else 0))
    rounds: dict[str, dict[str, list[dict[str, Any]]]] = {}
    final: dict[str, Any] | None = None
    for row in ordered:
        if row["round"] == "final":
            if final is None:
                final = {
                    "category": row["category"], "clue": row["clue"], "answer": row["answer"],
                    "media": row.get("media") or None, "answerMedia": row.get("answer_media") or None,
                }
            continue
        categories = rounds.setdefault(row["round"], {})
        categories.setdefault(row["category"], []).append(
            {
                "value": int(row["value"]),
                "clue": row["clue"],
                "answer": row["answer"],
                "dd": bool(row.get("daily_double")),
                "media": row.get("media") or None,
                "answerMedia": row.get("answer_media") or None,
                "_order": row.get("sort_order") or 0,
            }
        )

    def round_key(key: str) -> tuple[int, str]:
        return (int(key), key) if key.isdigit() else (999, key)

    out_rounds = []
    for number, key in enumerate(sorted(rounds, key=round_key), start=1):
        categories = []
        for name, clues in rounds[key].items():
            clues.sort(key=lambda c: (c["value"], c["_order"]))
            for clue in clues:
                clue.pop("_order", None)
            categories.append({"name": name, "clues": clues})
        out_rounds.append({"key": key, "name": ("Jeopardy", "Double Jeopardy")[number - 1] if number <= 2 else f"Round {number}", "categories": categories})
    return {"id": game_id, "title": game_id, "source": source, "rounds": out_rounds, "final": final}


_sample: dict[str, Any] | None = None


def sample_game() -> dict[str, Any]:
    global _sample
    if _sample is None:
        _sample = json.loads((BASE_DIR / "sample_game.json").read_text(encoding="utf-8"))
        _sample["source"] = "sample"
    return _sample


def _sample_summary() -> dict[str, Any]:
    game = sample_game()
    clues = sum(len(c["clues"]) for r in game["rounds"] for c in r["categories"]) + (1 if game["final"] else 0)
    cats = sum(len(r["categories"]) for r in game["rounds"])
    return {"id": SAMPLE_ID, "title": game["title"], "clues": clues, "categories": cats, "rounds": len(game["rounds"]), "hasFinal": bool(game["final"]), "source": "sample", "updated": None}


# ---------------------------------------------------------------------------------------------
# Table operations
# ---------------------------------------------------------------------------------------------

def list_games() -> dict[str, Any]:
    """{'games': [...], 'source': 'supabase'|'sample', 'warning': str|None}"""
    if not database_configured():
        return {"games": [_sample_summary()], "source": "sample", "warning": "No database is configured, so the built-in sample board is shown."}
    try:
        rows = db.fetch_all(
            """
            SELECT game_id,
                   count(*) AS clues,
                   count(DISTINCT CASE WHEN round <> 'final' THEN round || ':' || category END) AS categories,
                   count(DISTINCT CASE WHEN round <> 'final' THEN round END) AS rounds,
                   max(CASE WHEN round = 'final' THEN 1 ELSE 0 END) AS has_final,
                   max(updated_at) AS updated
            FROM fj_questions
            GROUP BY game_id
            ORDER BY game_id
            """
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("could not read fj_questions: %s", exc)
        return {"games": [_sample_summary()], "source": "sample", "warning": "The question table could not be read, so the built-in sample board is shown."}
    games = [
        {
            "id": r["game_id"], "title": r["game_id"], "clues": int(r["clues"]), "categories": int(r["categories"]),
            "rounds": int(r["rounds"]), "hasFinal": bool(r["has_final"]), "source": SOURCE,
            "updated": r["updated"].isoformat() if r["updated"] else None,
        }
        for r in rows
    ]
    if not games:
        return {"games": [_sample_summary()], "source": "sample", "warning": "No question sets are saved yet, so the built-in sample board is shown. Upload yours in Manage questions."}
    return {"games": games, "source": SOURCE, "warning": None}


def get_game(game_id: str) -> dict[str, Any] | None:
    if game_id == SAMPLE_ID:
        return sample_game()
    if not database_configured():
        return None
    rows = db.fetch_all(
        """
        SELECT round, category, value, clue, answer, daily_double, sort_order, media, answer_media
        FROM fj_questions WHERE game_id = %s ORDER BY sort_order
        """,
        (game_id,),
    )
    if not rows:
        return None
    return build_game(game_id, rows, SOURCE)


def replace_game(game_id: str, rows: list[dict[str, Any]], user: str) -> list[str]:
    """Replace one question set. Other sets are untouched."""
    if not database_configured():
        raise RuntimeError("No database is configured for this app.")
    params = [
        (game_id, r["round"], r["category"], r["value"], r["clue"], r["answer"], bool(r["daily_double"]), int(r["sort_order"]), user, r.get("media") or None, r.get("answer_media") or None)
        for r in rows
    ]
    with db.connection() as conn:
        with conn.transaction():
            conn.execute("DELETE FROM fj_questions WHERE game_id = %s", (game_id,))
            with conn.cursor() as cur:
                cur.executemany(
                    "INSERT INTO fj_questions (game_id, round, category, value, clue, answer, daily_double, sort_order, updated_by, media, answer_media)"
                    " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                    params,
                )
    return []


def delete_game(game_id: str) -> None:
    if not database_configured():
        raise RuntimeError("No database is configured for this app.")
    db.run("DELETE FROM fj_questions WHERE game_id = %s", (game_id,))
