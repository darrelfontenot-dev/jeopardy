"""Postgres access (Supabase). Connections come from a small pool; every call checks one out only briefly."""

from __future__ import annotations

import os
import threading
from contextlib import contextmanager
from typing import Any, Iterator

DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()

_pool = None
_lock = threading.Lock()


def configured() -> bool:
    return bool(DATABASE_URL)


def _get_pool():
    global _pool
    if _pool is None:
        with _lock:
            if _pool is None:
                from psycopg.rows import dict_row
                from psycopg_pool import ConnectionPool

                # prepare_threshold=None: Supabase's transaction pooler does not support prepared statements.
                _pool = ConnectionPool(
                    DATABASE_URL,
                    min_size=1,
                    max_size=int(os.environ.get("DB_POOL_SIZE", "10")),
                    timeout=10,
                    kwargs={"autocommit": True, "prepare_threshold": None, "row_factory": dict_row},
                    open=True,
                )
    return _pool


@contextmanager
def connection() -> Iterator[Any]:
    if not DATABASE_URL:
        raise RuntimeError("No database is configured (set DATABASE_URL).")
    with _get_pool().connection() as conn:
        yield conn


def fetch_all(sql: str, params: tuple | list = ()) -> list[dict[str, Any]]:
    with connection() as conn:
        return conn.execute(sql, params).fetchall()


def fetch_one(sql: str, params: tuple | list = ()) -> dict[str, Any] | None:
    with connection() as conn:
        return conn.execute(sql, params).fetchone()


def run(sql: str, params: tuple | list = ()) -> None:
    with connection() as conn:
        conn.execute(sql, params)
