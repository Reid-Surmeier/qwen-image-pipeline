import base64
import hashlib
import json
import unittest
from pathlib import Path

from qwen_ui_pipeline.qwen_adapter import (
    QWEN_ADAPTER_PROTOCOL_VERSION,
    QwenKernelError,
    invoke_qwen_kernel,
)


class _Client:
    def __init__(self, response):
        self.response = response
        self.requests = []

    def generate(self, request):
        self.requests.append(request)
        if isinstance(self.response, Exception):
            raise self.response
        return self.response


def _request(count=1):
    reference = b"reference-png"
    return {
        "adapter_protocol_version": QWEN_ADAPTER_PROTOCOL_VERSION,
        "operation": "invoke",
        "provider": "openrouter",
        "model": "qwen/qwen-image-3-pro",
        "objective": "Preserve the source and replace only the named region.",
        "requested_count": count,
        "parameters": {"resolution": "1K", "aspect_ratio": "1:1", "seed": 42},
        "references": [
            {
                "slot": "source",
                "application_path": "references/source.png",
                "sha256": __import__("hashlib").sha256(reference).hexdigest(),
                "payload_destination": "/input_references/0/image_url/url",
                "media_type": "image/png",
                "bytes_base64": base64.b64encode(reference).decode("ascii"),
            }
        ],
    }


class QwenAdapterTests(unittest.TestCase):
    def test_reads_the_hash_locked_sanitized_historical_response_fixture(self):
        fixture_path = (
            Path(__file__).resolve().parents[1]
            / "artifacts"
            / "runs"
            / "museum-filter-retro-skin-v001"
            / "response.json"
        )
        fixture_bytes = fixture_path.read_bytes()
        self.assertEqual(
            hashlib.sha256(fixture_bytes).hexdigest(),
            "2f8afb79cc4acbf0b75578ab96e39f6c76b8f5443575fe242602e12ab2c70591",
        )
        captured = json.loads(fixture_bytes)
        self.assertEqual(
            captured,
            {
                "data": [
                    {
                        "bytes": 1302054,
                        "media_type": "image/png",
                        "sha256": "7846863002b7449aac9801fa49a173e58030cfacc39f1c909cf5f88ab15bd2c9",
                    },
                    {
                        "bytes": 1602604,
                        "media_type": "image/png",
                        "sha256": "e3a08396754a2f44bca9ac9b2dda86d597313d58cfcc5adffc9387f9ed919169",
                    },
                ]
            },
        )

    def test_invokes_the_inherited_openrouter_kernel_with_exact_locked_evidence(self):
        client = _Client(
            {
                "id": "captured-qwen-1",
                "data": [
                    {
                        "b64_json": base64.b64encode(b"provider-image").decode("ascii"),
                        "media_type": "image/png",
                    }
                ],
            }
        )
        result = invoke_qwen_kernel(
            _request(),
            client=client,
            decode_image=lambda body, media_type: (1, 1, [10, 20, 30, 255]),
        )

        self.assertEqual(len(client.requests), 1)
        provider_request = client.requests[0]
        self.assertEqual(provider_request["model"], "qwen/qwen-image-3-pro")
        self.assertEqual(provider_request["n"], 1)
        self.assertEqual(provider_request["resolution"], "1K")
        self.assertEqual(provider_request["aspect_ratio"], "1:1")
        self.assertEqual(provider_request["seed"], 42)
        self.assertIn(_request()["objective"], provider_request["prompt"])
        self.assertEqual(len(provider_request["input_references"]), 1)
        self.assertTrue(
            provider_request["input_references"][0]["image_url"]["url"].startswith(
                "data:image/png;base64,"
            )
        )
        self.assertEqual(result["adapter_protocol_version"], QWEN_ADAPTER_PROTOCOL_VERSION)
        self.assertEqual(result["provider"], "openrouter")
        raster = json.loads(base64.b64decode(result["outputs"][0]["body_base64"]))
        self.assertEqual(raster, {"height": 1, "pixels": [10, 20, 30, 255], "width": 1})
        receipt = json.loads(base64.b64decode(result["provider_evidence"]["body_base64"]))
        self.assertEqual(receipt, {"id": "captured-qwen-1", "status": "completed"})

    def test_rejects_count_mismatch_and_sanitizes_provider_rejection(self):
        mismatch = _Client({"id": "captured-qwen-2", "data": []})
        with self.assertRaisesRegex(QwenKernelError, "OUTPUT_COUNT_MISMATCH"):
            invoke_qwen_kernel(
                _request(),
                client=mismatch,
                decode_image=lambda body, media_type: (1, 1, [0, 0, 0, 255]),
            )

        rejected = _Client(RuntimeError("HTTP 429: retry later; Bearer super-secret-value"))
        with self.assertRaises(QwenKernelError) as raised:
            invoke_qwen_kernel(
                _request(),
                client=rejected,
                decode_image=lambda body, media_type: (1, 1, [0, 0, 0, 255]),
            )
        self.assertEqual(raised.exception.code, "PROVIDER_AMBIGUOUS")
        self.assertNotIn("super-secret-value", str(raised.exception))
        self.assertIsNone(raised.exception.__cause__)
        self.assertIsNone(raised.exception.__context__)

    def test_rejects_capability_drift_before_dispatch(self):
        for field, value in (
            ("resolution", "4K"),
            ("aspect_ratio", "source"),
            ("seed", -1),
        ):
            with self.subTest(field=field):
                request = _request()
                request["parameters"][field] = value
                client = _Client({"id": "must-not-run", "data": []})
                with self.assertRaisesRegex(QwenKernelError, "ADAPTER_NOT_STARTED"):
                    invoke_qwen_kernel(request, client=client)
                self.assertEqual(client.requests, [])


if __name__ == "__main__":
    unittest.main()
