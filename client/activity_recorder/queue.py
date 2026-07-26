from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from collections.abc import Iterator
from pathlib import Path
from typing import Any


class EventQueue:
    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=10)
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA busy_timeout=10000")
        return connection

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
        connection = self._connect()
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def _initialize(self) -> None:
        with self._connection() as connection:
            connection.execute(
                """CREATE TABLE IF NOT EXISTS pending_events (
                       id TEXT PRIMARY KEY,
                       payload TEXT NOT NULL,
                       created_at INTEGER NOT NULL DEFAULT (unixepoch())
                   )"""
            )

    def enqueue(self, event: dict[str, Any]) -> None:
        payload = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
        with self._connection() as connection:
            connection.execute(
                "INSERT OR IGNORE INTO pending_events (id, payload) VALUES (?, ?)",
                (event["id"], payload),
            )

    def next_batch(self, limit: int = 100) -> list[dict[str, Any]]:
        with self._connection() as connection:
            rows = connection.execute(
                "SELECT payload FROM pending_events ORDER BY created_at, rowid LIMIT ?",
                (max(1, min(100, limit)),),
            ).fetchall()
        return [json.loads(row[0]) for row in rows]

    def delete(self, event_ids: list[str]) -> None:
        if not event_ids:
            return
        placeholders = ",".join("?" for _ in event_ids)
        with self._connection() as connection:
            connection.execute(f"DELETE FROM pending_events WHERE id IN ({placeholders})", event_ids)

    def count(self) -> int:
        with self._connection() as connection:
            return int(connection.execute("SELECT COUNT(*) FROM pending_events").fetchone()[0])
