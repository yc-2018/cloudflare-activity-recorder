from __future__ import annotations

import time
from pathlib import Path
from typing import Callable


class PauseState:
    def __init__(self, path: Path, clock: Callable[[], float] = time.time):
        self.path = path
        self.clock = clock

    def active_until(self) -> int | None:
        try:
            until = int(self.path.read_text(encoding="ascii").strip())
        except (FileNotFoundError, OSError, ValueError):
            return None
        if until > int(self.clock()):
            return until
        try:
            self.path.unlink(missing_ok=True)
        except OSError:
            pass
        return None
