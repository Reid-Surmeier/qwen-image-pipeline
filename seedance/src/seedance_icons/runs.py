from __future__ import annotations

import json
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


def create_run(root: Path, slug: str) -> Path:
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    path = root / f"{stamp}-{slug}"
    path.mkdir(parents=True, exist_ok=False)
    for child in ("inputs", "outputs", "verification"):
        (path / child).mkdir()
    return path


def write_json(path: Path, payload: Any) -> None:
    path.write_text(json.dumps(payload, indent=2) + "\n")


def read_job_id(run: Path) -> str:
    payload = json.loads((run / "job.json").read_text())
    if not isinstance(payload, dict):
        raise TypeError("job.json is not an object")
    nested = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    job_id = payload.get("id") or nested.get("id")
    if not isinstance(job_id, str) or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", job_id) is None:
        raise ValueError("job.json has no safe exact provider identity")
    return job_id
