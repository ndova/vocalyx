import threading
import time
from pathlib import Path


_JOBS: dict = {}
_JOBS_LOCK = threading.Lock()


def _set_job(job_id: str, **kw):
    with _JOBS_LOCK:
        if job_id in _JOBS:
            kw.setdefault("at", time.time())
            _JOBS[job_id].update(kw)


def _tail_log(path: Path, n: int = 40) -> str:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
        return "".join(lines[-n:])
    except Exception:
        return ""
