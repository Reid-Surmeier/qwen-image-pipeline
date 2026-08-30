import json
from pathlib import Path

import httpx
import pytest

from seedance_icons.openrouter import (
    OpenRouterError,
    OpenRouterVideoClient,
    asset_reference,
    sanitized_request,
)


def test_asset_reference_encodes_local_image(tmp_path: Path):
    image = tmp_path / "icon.png"
    image.write_bytes(b"png bytes")
    ref = asset_reference(str(image), "image", "first_frame")
    assert ref["type"] == "image_url"
    assert ref["frame_type"] == "first_frame"
    assert ref["image_url"]["url"].startswith("data:image/png;base64,")


def test_sanitization_removes_data_urls_and_internal_fields():
    result = sanitized_request({"_note": True, "image": "data:image/png;base64,abc"})
    assert "_note" not in result
    assert result["image"].startswith("<data-url sha256=")


def test_client_uses_async_video_endpoints(tmp_path: Path):
    calls = []

    def handler(request: httpx.Request):
        calls.append((request.method, request.url.path))
        if request.method == "POST":
            assert json.loads(request.content)["model"] == "bytedance/seedance-2.0-mini"
            return httpx.Response(200, json={"id": "job-1", "status": "pending"})
        if request.url.path.endswith("/content"):
            return httpx.Response(200, content=b"video")
        return httpx.Response(200, json={"id": "job-1", "status": "completed"})

    http = httpx.Client(
        base_url="https://openrouter.ai/api/v1",
        headers={"Authorization": "Bearer test-key"},
        transport=httpx.MockTransport(handler),
    )
    client = OpenRouterVideoClient("test-key", http)
    assert client.submit({"model": "bytedance/seedance-2.0-mini"})["id"] == "job-1"
    assert client.wait("job-1", interval=0)["status"] == "completed"
    assert client.download("job-1", tmp_path / "output.mp4")
    assert calls == [
        ("POST", "/api/v1/videos"),
        ("GET", "/api/v1/videos/job-1"),
        ("GET", "/api/v1/videos/job-1/content"),
    ]


def test_submit_preserves_provider_400_as_a_safe_structured_failure():
    def handler(request: httpx.Request):
        assert request.headers["Authorization"] == "Bearer test-key"
        return httpx.Response(
            400,
            json={"error": {"message": "input_references[0] is invalid", "code": "bad_input"}},
            headers={
                "x-request-id": "req-400",
                "x-generation-id": "gen-400",
                "content-type": "application/json",
            },
        )

    http = httpx.Client(
        base_url="https://openrouter.ai/api/v1",
        headers={"Authorization": "Bearer test-key"},
        transport=httpx.MockTransport(handler),
    )
    client = OpenRouterVideoClient("test-key", http)

    with pytest.raises(OpenRouterError) as caught:
        client.submit({"model": "bytedance/seedance-2.0-mini"})

    assert caught.value.to_record() == {
        "error_class": "OpenRouterHTTPError",
        "operation": "submit",
        "method": "POST",
        "endpoint": "/videos",
        "status_code": 400,
        "response_body": (
            '{"error":{"message":"input_references[0] is invalid","code":"bad_input"}}'
        ),
        "provider_error": {
            "error": {"message": "input_references[0] is invalid", "code": "bad_input"}
        },
        "response_headers": {
            "content-type": "application/json",
            "x-generation-id": "gen-400",
            "x-request-id": "req-400",
        },
        "response_body_truncated": False,
        "safe_to_retry": False,
        "billing_status": "possibly_spent",
    }
    assert "test-key" not in str(caught.value)


def test_submit_caps_non_json_body_and_never_records_authorization():
    secret = "sk-or-v1-secret-should-not-survive"

    def handler(request: httpx.Request):
        return httpx.Response(
            502,
            content=(f"Authorization: Bearer {secret}\n" + "x" * 70_000).encode(),
            headers={
                "authorization": f"Bearer {secret}",
                "content-type": "text/plain",
                "x-request-id": "req-502",
            },
        )

    http = httpx.Client(
        base_url="https://openrouter.ai/api/v1",
        headers={"Authorization": f"Bearer {secret}"},
        transport=httpx.MockTransport(handler),
    )
    client = OpenRouterVideoClient(secret, http)

    with pytest.raises(OpenRouterError) as caught:
        client.submit({"model": "bytedance/seedance-2.0-mini"})

    record = caught.value.to_record()
    assert record["provider_error"] is None
    assert record["response_body_truncated"] is True
    assert len(record["response_body"].encode()) <= 65_536
    assert record["response_headers"] == {
        "content-type": "text/plain",
        "x-request-id": "req-502",
    }
    assert secret not in json.dumps(record)


def test_submit_redacts_reflected_credentials_from_json_error_records():
    secrets = {
        "authorization": "reflected-secret",
        "api_key": "api-key-secret",
        "token": "token-secret",
        "cookie": "cookie-secret",
        "bare_bearer": "bare-secret",
        "openrouter_key": "sk-or-v1-reflected-secret",
        "query": "query-secret",
        "url_password": "url-password-secret",
    }

    def handler(request: httpx.Request):
        return httpx.Response(
            400,
            json={
                "authorization": f"Bearer {secrets['authorization']}",
                "api_key": secrets["api_key"],
                "nested": {
                    "token": secrets["token"],
                    "cookie": f"session={secrets['cookie']}",
                },
                "message": (
                    f"upstream forwarded Bearer {secrets['bare_bearer']} to "
                    f"https://user:{secrets['url_password']}@example.invalid/callback"
                    f"?api_key={secrets['query']} with {secrets['openrouter_key']}"
                ),
            },
        )

    http = httpx.Client(
        base_url="https://openrouter.ai/api/v1",
        headers={"Authorization": "Bearer request-secret"},
        transport=httpx.MockTransport(handler),
    )
    client = OpenRouterVideoClient("request-secret", http)

    with pytest.raises(OpenRouterError) as caught:
        client.submit({"model": "bytedance/seedance-2.0-mini"})

    serialized = json.dumps(caught.value.to_record())
    for secret in (*secrets.values(), "request-secret"):
        assert secret not in serialized


def test_submit_caps_persisted_body_after_invalid_utf8_expansion():
    def handler(request: httpx.Request):
        return httpx.Response(502, content=b"\xff" * 70_000)

    http = httpx.Client(
        base_url="https://openrouter.ai/api/v1",
        transport=httpx.MockTransport(handler),
    )
    client = OpenRouterVideoClient("test-key", http)

    with pytest.raises(OpenRouterError) as caught:
        client.submit({"model": "bytedance/seedance-2.0-mini"})

    record = caught.value.to_record()
    assert record["response_body_truncated"] is True
    assert len(record["response_body"].encode("utf-8")) <= 65_536
    assert record["response_body"].endswith("<TRUNCATED>")
