from __future__ import annotations

import ctypes
import platform
import socket
import sys
import winreg
from dataclasses import dataclass
from typing import Any

import psutil


UNKNOWN = "unknown"


@dataclass(frozen=True)
class ForegroundWindow:
    process_name: str
    title: str
    mode: str = "active"

    @property
    def key(self) -> tuple[str, str, str]:
        return self.process_name, self.title, self.mode

    @property
    def is_available(self) -> bool:
        return self.mode != "unavailable"

    @property
    def allows_heartbeat(self) -> bool:
        return self.mode == "active"


def _workstation_locked(user32: Any) -> bool:
    desktop_switch_desktop = 0x0100
    try:
        user32.OpenInputDesktop.argtypes = [ctypes.c_uint, ctypes.c_bool, ctypes.c_uint]
        user32.OpenInputDesktop.restype = ctypes.c_void_p
        user32.SwitchDesktop.argtypes = [ctypes.c_void_p]
        user32.SwitchDesktop.restype = ctypes.c_bool
        user32.CloseDesktop.argtypes = [ctypes.c_void_p]
        user32.CloseDesktop.restype = ctypes.c_bool
        desktop = user32.OpenInputDesktop(0, False, desktop_switch_desktop)
        if not desktop:
            return True
        try:
            return not bool(user32.SwitchDesktop(desktop))
        finally:
            user32.CloseDesktop(desktop)
    except (AttributeError, OSError, ValueError):
        return False


def _registry_value(path: str, name: str) -> str:
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, path) as key:
            value, _ = winreg.QueryValueEx(key, name)
            return str(value).strip() or UNKNOWN
    except OSError:
        return UNKNOWN


def device_details(device_id: str, device_name: str | None = None) -> dict[str, str]:
    return {
        "id": device_id,
        "name": device_name or socket.gethostname() or UNKNOWN,
        "manufacturer": _registry_value(r"HARDWARE\DESCRIPTION\System\BIOS", "SystemManufacturer"),
        "model": _registry_value(r"HARDWARE\DESCRIPTION\System\BIOS", "SystemProductName"),
        "osVersion": platform.platform(terse=False) or UNKNOWN,
        "cpuModel": _registry_value(r"HARDWARE\DESCRIPTION\System\CentralProcessor\0", "ProcessorNameString"),
    }


def foreground_window() -> ForegroundWindow:
    if sys.platform != "win32":
        return ForegroundWindow(UNKNOWN, UNKNOWN, "unavailable")
    try:
        user32 = ctypes.windll.user32
        if _workstation_locked(user32):
            return ForegroundWindow("LockScreen", "锁屏", "locked")
        handle = user32.GetForegroundWindow()
        if not handle:
            return ForegroundWindow(UNKNOWN, UNKNOWN, "unavailable")
        length = user32.GetWindowTextLengthW(handle)
        buffer = ctypes.create_unicode_buffer(max(1, length + 1))
        user32.GetWindowTextW(handle, buffer, len(buffer))
        process_id = ctypes.c_ulong()
        user32.GetWindowThreadProcessId(handle, ctypes.byref(process_id))
        try:
            process_name = psutil.Process(process_id.value).name() or UNKNOWN
        except (psutil.Error, OSError):
            process_name = UNKNOWN
        title = buffer.value.strip()
        normalized_process = process_name.lower()
        if normalized_process in {"lockapp.exe", "logonui.exe"}:
            return ForegroundWindow("LockScreen", "锁屏", "locked")
        if normalized_process == "explorer.exe" and not title:
            return ForegroundWindow("Desktop", "桌面", "desktop")
        if process_name == UNKNOWN:
            return ForegroundWindow(UNKNOWN, UNKNOWN, "unavailable")
        return ForegroundWindow(process_name[:128], title[:512])
    except (AttributeError, OSError, ValueError):
        return ForegroundWindow(UNKNOWN, UNKNOWN, "unavailable")


def system_metrics() -> dict[str, Any]:
    try:
        cpu_percent = max(0.0, min(100.0, float(psutil.cpu_percent(interval=None))))
    except (psutil.Error, OSError, ValueError):
        cpu_percent = 0.0
    try:
        memory_percent = max(0.0, min(100.0, float(psutil.virtual_memory().percent)))
    except (psutil.Error, OSError, ValueError):
        memory_percent = 0.0
    try:
        battery = psutil.sensors_battery()
    except (psutil.Error, OSError, AttributeError):
        battery = None
    return {
        "cpuPercent": round(cpu_percent, 1),
        "memoryPercent": round(memory_percent, 1),
        "batteryPercent": round(float(battery.percent), 1) if battery is not None else None,
        "powerPlugged": bool(battery.power_plugged) if battery is not None else None,
    }
