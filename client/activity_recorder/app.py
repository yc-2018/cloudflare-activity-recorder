from __future__ import annotations

import logging
import signal
import threading
import time
import uuid
from dataclasses import replace
from datetime import datetime, timezone
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Callable

import psutil

from .config import Config, data_directory, load_config
from .pause import PauseState
from .queue import EventQueue
from .system import ForegroundWindow, device_details, device_fingerprint, foreground_window, system_metrics
from .uploader import Uploader, register_device


class SamplingPolicy:
    def __init__(self, heartbeat_seconds: float):
        self.heartbeat_seconds = heartbeat_seconds
        self.last_window: tuple[str, str, str] | None = None
        self.last_sample_at: float | None = None

    def reset(self) -> None:
        self.last_window = None
        self.last_sample_at = None

    def trigger(self, window: ForegroundWindow, now: float) -> str | None:
        if not window.is_available:
            return None
        if self.last_window != window.key:
            self.last_window = window.key
            self.last_sample_at = now
            return "window_change"
        if not window.allows_heartbeat:
            return None
        if self.last_sample_at is None or now - self.last_sample_at >= self.heartbeat_seconds:
            self.last_sample_at = now
            return "heartbeat"
        return None


def build_event(config: Config, device: dict[str, str], window: ForegroundWindow, trigger: str) -> dict[str, object]:
    return {
        "id": str(uuid.uuid4()),
        "observedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "trigger": trigger,
        "device": device,
        "activity": {"processName": window.process_name, "windowTitle": window.title},
        "metrics": system_metrics(),
    }


def configure_logging(directory: Path) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(directory / "recorder.log", maxBytes=1_000_000, backupCount=3, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logging.basicConfig(level=logging.INFO, handlers=[handler])


def run_recorder(
    config: Config,
    queue: EventQueue,
    stop_event: threading.Event,
    wake_event: threading.Event,
    window_reader: Callable[[], ForegroundWindow] = foreground_window,
) -> None:
    device = device_details(config.device_id, config.device_name, config.fingerprint)
    policy = SamplingPolicy(config.heartbeat_seconds)
    pause_state = PauseState(data_directory() / "pause_until.txt")
    was_paused = False
    psutil.cpu_percent(interval=None)
    logging.info("Recorder started for device %s (%s)", device["name"], config.device_id)
    while not stop_event.is_set():
        try:
            paused_until = pause_state.active_until()
            if paused_until is not None:
                if not was_paused:
                    policy.reset()
                    logging.info("Collection paused until Unix timestamp %d", paused_until)
                was_paused = True
                stop_event.wait(config.poll_seconds)
                continue
            if was_paused:
                policy.reset()
                logging.info("Collection resumed")
                was_paused = False
            window = window_reader()
            trigger = policy.trigger(window, time.monotonic())
            if trigger:
                queue.enqueue(build_event(config, device, window, trigger))
                wake_event.set()
        except Exception:
            logging.exception("Sampling failed; retrying on the next poll")
        stop_event.wait(config.poll_seconds)
    logging.info("Recorder stopped")


def main() -> None:
    directory = data_directory()
    configure_logging(directory)
    try:
        config = load_config(directory / "config.json")
        queue = EventQueue(directory / "queue.sqlite3")
    except Exception:
        logging.exception("Recorder cannot start")
        raise

    # Resolve the stable device identity: the server maps the hardware
    # fingerprint to a short numeric id, so an OS reinstall keeps the same
    # device (and the id stays compact in storage).
    fingerprint = config.fingerprint or device_fingerprint()
    device_id = config.device_id
    try:
        registered = register_device(
            config.endpoint,
            config.ingest_token,
            device_details(device_id, config.device_name, fingerprint),
        )
        if registered:
            device_id = registered
            logging.info("Device registered as %s (fingerprint %s)", device_id, fingerprint[:12])
    except Exception:
        logging.warning("Device registration failed; using configured id", exc_info=True)
    config = replace(config, device_id=device_id, fingerprint=fingerprint)

    stop_event = threading.Event()
    wake_event = threading.Event()

    def stop(*_: object) -> None:
        stop_event.set()
        wake_event.set()

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    if hasattr(signal, "SIGBREAK"):
        signal.signal(signal.SIGBREAK, stop)

    uploader = Uploader(config, queue, wake_event)
    upload_thread = threading.Thread(target=uploader.run, args=(stop_event,), name="activity-uploader", daemon=True)
    upload_thread.start()
    run_recorder(config, queue, stop_event, wake_event)
    upload_thread.join(timeout=10)
