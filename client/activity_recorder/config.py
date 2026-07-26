from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path


APP_DIRECTORY_NAME = "ActivityRecorder"


def data_directory() -> Path:
    local_app_data = os.environ.get("LOCALAPPDATA")
    if not local_app_data:
        raise RuntimeError("LOCALAPPDATA is not available; this client only supports Windows")
    return Path(local_app_data) / APP_DIRECTORY_NAME


@dataclass(frozen=True)
class Config:
    endpoint: str
    ingest_token: str
    device_id: str
    device_name: str | None = None
    poll_seconds: float = 1.0
    heartbeat_seconds: float = 300.0


def load_config(path: Path | None = None) -> Config:
    config_path = path or data_directory() / "config.json"
    try:
        # Windows PowerShell 5.1 writes UTF-8 JSON with a BOM by default.
        raw = json.loads(config_path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError as error:
        raise RuntimeError(f"Config file not found: {config_path}") from error
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Cannot read config file: {error}") from error

    required = ("endpoint", "ingest_token", "device_id")
    missing = [key for key in required if not isinstance(raw.get(key), str) or not raw[key].strip()]
    if missing:
        raise RuntimeError(f"Config is missing required values: {', '.join(missing)}")
    poll_seconds = float(raw.get("poll_seconds", 1))
    heartbeat_seconds = float(raw.get("heartbeat_seconds", 300))
    if poll_seconds <= 0 or heartbeat_seconds <= 0:
        raise RuntimeError("poll_seconds and heartbeat_seconds must be positive")

    return Config(
        endpoint=raw["endpoint"].strip().rstrip("/"),
        ingest_token=raw["ingest_token"].strip(),
        device_id=raw["device_id"].strip(),
        device_name=(str(raw.get("device_name", "")).strip() or None),
        poll_seconds=poll_seconds,
        heartbeat_seconds=heartbeat_seconds,
    )
