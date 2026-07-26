from __future__ import annotations

import tempfile
import threading
import unittest
import sys
import json
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from activity_recorder.app import SamplingPolicy
from activity_recorder.config import Config, load_config
from activity_recorder.queue import EventQueue
from activity_recorder.pause import PauseState
from activity_recorder.system import ForegroundWindow, system_metrics
from activity_recorder.uploader import Uploader


def event(event_id: str) -> dict[str, object]:
    return {"id": event_id, "value": event_id}


class SamplingPolicyTests(unittest.TestCase):
    def test_window_changes_and_heartbeats_trigger_samples(self) -> None:
        policy = SamplingPolicy(heartbeat_seconds=300)
        editor = ForegroundWindow("code.exe", "Project")
        browser = ForegroundWindow("chrome.exe", "Docs")

        self.assertEqual(policy.trigger(editor, 100), "window_change")
        self.assertIsNone(policy.trigger(editor, 399.9))
        self.assertEqual(policy.trigger(editor, 400), "heartbeat")
        self.assertEqual(policy.trigger(browser, 401), "window_change")

    def test_lock_and_desktop_are_recorded_once_without_heartbeats(self) -> None:
        policy = SamplingPolicy(heartbeat_seconds=300)
        locked = ForegroundWindow("LockScreen", "锁屏", "locked")
        desktop = ForegroundWindow("Desktop", "桌面", "desktop")

        self.assertEqual(policy.trigger(locked, 100), "window_change")
        self.assertIsNone(policy.trigger(locked, 500))
        self.assertEqual(policy.trigger(desktop, 501), "window_change")
        self.assertIsNone(policy.trigger(desktop, 900))

    def test_unavailable_windows_are_ignored_without_losing_previous_state(self) -> None:
        policy = SamplingPolicy(heartbeat_seconds=300)
        editor = ForegroundWindow("code.exe", "Project")
        unavailable = ForegroundWindow("unknown", "unknown", "unavailable")

        self.assertEqual(policy.trigger(editor, 100), "window_change")
        self.assertIsNone(policy.trigger(unavailable, 101))
        self.assertIsNone(policy.trigger(editor, 102))


class ConfigTests(unittest.TestCase):
    def test_loads_powershell_utf8_bom_config(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            path.write_text(json.dumps({
                "endpoint": "https://example.test",
                "ingest_token": "token",
                "device_id": "device",
            }), encoding="utf-8-sig")
            self.assertEqual(load_config(path).endpoint, "https://example.test")


class PauseStateTests(unittest.TestCase):
    def test_active_pause_returns_deadline(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "pause_until.txt"
            path.write_text("1300", encoding="ascii")
            self.assertEqual(PauseState(path, clock=lambda: 1000).active_until(), 1300)

    def test_expired_pause_is_removed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "pause_until.txt"
            path.write_text("900", encoding="ascii")
            self.assertIsNone(PauseState(path, clock=lambda: 1000).active_until())
            self.assertFalse(path.exists())

    def test_invalid_pause_marker_is_ignored(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "pause_until.txt"
            path.write_text("invalid", encoding="ascii")
            self.assertIsNone(PauseState(path, clock=lambda: 1000).active_until())


class QueueTests(unittest.TestCase):
    def test_queue_is_idempotent_and_deletes_only_confirmed_ids(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            queue = EventQueue(Path(directory) / "queue.sqlite3")
            queue.enqueue(event("one"))
            queue.enqueue(event("one"))
            queue.enqueue(event("two"))
            self.assertEqual(queue.count(), 2)
            self.assertEqual([item["id"] for item in queue.next_batch()], ["one", "two"])
            queue.delete(["one"])
            self.assertEqual([item["id"] for item in queue.next_batch()], ["two"])


class UploaderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.queue = EventQueue(Path(self.temp.name) / "queue.sqlite3")
        self.config = Config("https://example.test", "token", "device")

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_successful_batch_is_removed_after_full_acknowledgement(self) -> None:
        self.queue.enqueue(event("one"))
        self.queue.enqueue(event("two"))

        def upload(_endpoint: str, _token: str, events: list[dict[str, object]]) -> dict[str, int]:
            self.assertEqual(len(events), 2)
            return {"accepted": 1, "duplicates": 1, "rejected": 0}

        uploader = Uploader(self.config, self.queue, threading.Event(), upload)
        self.assertTrue(uploader.upload_once())
        self.assertEqual(self.queue.count(), 0)

    def test_incomplete_acknowledgement_keeps_the_batch(self) -> None:
        self.queue.enqueue(event("one"))

        def upload(_endpoint: str, _token: str, _events: list[dict[str, object]]) -> dict[str, int]:
            return {"accepted": 0, "duplicates": 0, "rejected": 0}

        uploader = Uploader(self.config, self.queue, threading.Event(), upload)
        with self.assertRaises(RuntimeError):
            uploader.upload_once()
        self.assertEqual(self.queue.count(), 1)


class MetricsTests(unittest.TestCase):
    @patch("activity_recorder.system.psutil.sensors_battery", return_value=None)
    @patch("activity_recorder.system.psutil.virtual_memory")
    @patch("activity_recorder.system.psutil.cpu_percent", side_effect=OSError("unavailable"))
    def test_missing_cpu_and_battery_are_safe(self, _cpu, memory, _battery) -> None:
        memory.return_value.percent = 41.25
        self.assertEqual(system_metrics(), {
            "cpuPercent": 0.0,
            "memoryPercent": 41.2,
            "batteryPercent": None,
            "powerPlugged": None,
        })


if __name__ == "__main__":
    unittest.main()
