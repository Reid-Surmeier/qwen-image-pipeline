import base64
import hashlib
from pathlib import Path

import pytest

from seedance_icons.adapter_host import AdapterError, execute


def request(operation: str, kind: str = "image") -> dict:
    body = b"locked-reference"
    media_type = "image/png" if kind == "image" else "video/mp4"
    return {
        "adapter_protocol_version": "1",
        "operation": operation,
        "model": "bytedance/seedance-test",
        "objective": "Move once, then return.",
        "video_plan": {"expectedMedia": {"width": 64, "height": 48, "durationSeconds": 1, "audioExpected": False}},
        "payload": {"input_references": [{f"{kind}_url": {"url": {
            "applicationPath": f"references/source.{media_type.split('/')[-1]}",
            "bytesBase64": base64.b64encode(body).decode(),
            "mediaType": media_type,
            "sha256": hashlib.sha256(body).hexdigest(),
        }}}]},
        **({"job_id": "job-1"} if operation == "poll" else {}),
    }


def test_adapter_host_normalizes_submit_pending_completed_and_refusal(tmp_path: Path) -> None:
    submitted_requests = []

    class SubmitClient:
        def submit(self, value: dict) -> dict:
            submitted_requests.append(value)
            return {"id": "job-1", "status": "queued"}

    submitted = execute(request("submit"), client=SubmitClient())
    assert submitted["job_id"] == "job-1"
    assert submitted_requests[0]["frame_images"][0]["frame_type"] == "first_frame"
    assert "input_references" not in submitted_requests[0]

    class PendingClient:
        def status(self, _job_id: str) -> dict:
            return {"id": "job-1", "status": "processing"}

    assert execute(request("poll"), client=PendingClient())["status"] == "pending"

    class CompletedClient:
        def status(self, _job_id: str) -> dict:
            return {"id": "job-1", "status": "completed", "usage": {"cost": 0.125}}

        def download(self, _job_id: str, destination: Path) -> str:
            destination.write_bytes(b"video")
            return hashlib.sha256(b"video").hexdigest()

    completed = execute(request("poll"), client=CompletedClient())
    assert completed["status"] == "completed"
    assert completed["cost"] == {"state": "actual", "actual_cost_usd": "0.125"}
    assert base64.b64decode(completed["outputs"][0]["body_base64"]) == b"video"

    class RejectedClient:
        def status(self, _job_id: str) -> dict:
            return {"id": "job-1", "status": "rejected"}

    with pytest.raises(AdapterError, match="rejected"):
        execute(request("poll"), client=RejectedClient())

    malformed = request("submit")
    malformed["payload"]["input_references"][0]["image_url"]["url"]["sha256"] = "0" * 64
    with pytest.raises(AdapterError, match="locked evidence"):
        execute(malformed, client=SubmitClient())

    video_submit = request("submit", "video")
    execute(video_submit, client=SubmitClient())
    assert submitted_requests[-1]["input_references"][0]["type"] == "video_url"
