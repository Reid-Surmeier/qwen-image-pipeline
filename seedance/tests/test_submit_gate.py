from __future__ import annotations

import json
from argparse import Namespace
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from seedance_icons.cli import cmd_submit
from seedance_icons.openrouter import OpenRouterHTTPError, request_digest
from seedance_icons.strategy import gate_record


def test_submit_refuses_a_payload_changed_after_planning(tmp_path: Path) -> None:
    request = {
        "model": "bytedance/seedance-2.0-mini",
        "prompt": "planned prompt",
        "duration": 12,
        "size": "480x480",
        "input_references": [
            {
                "type": "video_url",
                "video_url": {
                    "url": "https://example.test/ref-textbox-arrow-bob.mp4"
                },
            }
        ],
    }
    plan = {
        "request_sha256": request_digest(request),
        "estimated_cost_usd": "0.1361",
        "canonical_slug": "bytedance/seedance-2.0-mini-20260811",
        "strategy_gate": gate_record([], None),
    }
    (tmp_path / "plan.json").write_text(json.dumps(plan))

    request["input_references"] = []
    (tmp_path / "request.payload.json").write_text(json.dumps(request))

    with pytest.raises(SystemExit, match="Request payload changed since planning"):
        cmd_submit(Namespace(run=str(tmp_path), acknowledge_cost="0.1361"))


def test_submit_records_an_http_failure_as_a_possibly_spent_attempt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    request = {
        "model": "bytedance/seedance-2.0-mini",
        "prompt": "planned prompt",
        "duration": 4,
        "size": "480x480",
    }
    plan = {
        "request_sha256": request_digest(request),
        "estimated_cost_usd": "0.0454",
        "canonical_slug": "bytedance/seedance-2.0-mini-20260811",
        "paid_submission_performed": False,
        "strategy_gate": gate_record([], None),
    }
    (tmp_path / "plan.json").write_text(json.dumps(plan))
    (tmp_path / "request.payload.json").write_text(json.dumps(request))

    response = httpx.Response(
        400,
        json={"error": {"message": "video_url is not supported"}},
        headers={"x-request-id": "req-bad-video"},
        request=httpx.Request("POST", "https://openrouter.ai/api/v1/videos"),
    )
    failure = OpenRouterHTTPError("submit", "/videos", response)

    class FailingClient:
        closed = False

        def submit(self, _request: dict) -> dict:
            raise failure

        def close(self) -> None:
            self.closed = True

    client = FailingClient()
    monkeypatch.setattr("seedance_icons.cli.OpenRouterVideoClient", lambda: client)
    monkeypatch.setattr(
        "seedance_icons.cli.fetch_profiles",
        lambda: {
            request["model"]: SimpleNamespace(canonical_slug=plan["canonical_slug"])
        },
    )
    monkeypatch.setattr("seedance_icons.cli.validate_request", lambda *_args: None)

    with pytest.raises(OpenRouterHTTPError):
        cmd_submit(Namespace(run=str(tmp_path), acknowledge_cost="0.0454"))

    recorded_plan = json.loads((tmp_path / "plan.json").read_text())
    assert recorded_plan["paid_submission_performed"] is True
    assert recorded_plan["submission_status"] == "failed"
    assert recorded_plan["billing_status"] == "possibly_spent"
    assert recorded_plan["safe_to_retry"] is False
    assert json.loads((tmp_path / "provider-error.json").read_text()) == failure.to_record()
    assert not (tmp_path / "job.json").exists()
    assert client.closed is True
