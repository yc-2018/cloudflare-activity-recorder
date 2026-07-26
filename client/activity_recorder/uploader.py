from __future__ import annotations

import json
import logging
import threading
import urllib.error
import urllib.request
from collections.abc import Callable
from typing import Any

from .config import Config
from .queue import EventQueue


UploadFunction = Callable[[str, str, list[dict[str, Any]]], dict[str, int]]


def post_events(endpoint: str, token: str, events: list[dict[str, Any]]) -> dict[str, int]:
    request = urllib.request.Request(
        f"{endpoint}/api/v1/events",
        data=json.dumps({"events": events}, ensure_ascii=False).encode("utf-8"),
        method="POST",
        headers={
            "authorization": f"Bearer {token}",
            "content-type": "application/json; charset=utf-8",
            "user-agent": "ActivityRecorder/1.0",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        message = error.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"Server returned HTTP {error.code}: {message}") from error
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise RuntimeError(f"Upload failed: {error}") from error
    if not isinstance(payload, dict):
        raise RuntimeError("Server returned an invalid response")
    try:
        return {key: int(payload[key]) for key in ("accepted", "duplicates", "rejected")}
    except (KeyError, TypeError, ValueError) as error:
        raise RuntimeError("Server response is missing acknowledgement counts") from error


class Uploader:
    def __init__(
        self,
        config: Config,
        queue: EventQueue,
        wake_event: threading.Event,
        upload_function: UploadFunction = post_events,
    ):
        self.config = config
        self.queue = queue
        self.wake_event = wake_event
        self.upload_function = upload_function

    def upload_once(self) -> bool:
        batch = self.queue.next_batch(100)
        if not batch:
            return False
        result = self.upload_function(self.config.endpoint, self.config.ingest_token, batch)
        acknowledged = result["accepted"] + result["duplicates"] + result["rejected"]
        if acknowledged != len(batch):
            raise RuntimeError(f"Server acknowledged {acknowledged} of {len(batch)} events")
        self.queue.delete([event["id"] for event in batch])
        logging.info(
            "Uploaded %d events (%d accepted, %d duplicate, %d rejected)",
            len(batch), result["accepted"], result["duplicates"], result["rejected"],
        )
        return True

    def run(self, stop_event: threading.Event) -> None:
        backoff = 1.0
        while not stop_event.is_set():
            try:
                uploaded = self.upload_once()
                backoff = 1.0
                if uploaded:
                    continue
                self.wake_event.wait(5)
                self.wake_event.clear()
            except Exception as error:  # The local queue must survive every network failure.
                logging.warning("Upload postponed: %s", error)
                stop_event.wait(backoff)
                backoff = min(300.0, backoff * 2)
