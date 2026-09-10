import json
import tempfile
import os
import unittest
import urllib.error
from io import BytesIO
from pathlib import Path
from unittest import mock

from qwen_ui_pipeline import (
    OpenRouterImageClient,
    build_openrouter_request,
    write_run_artifacts,
)
from qwen_ui_pipeline.providers.openrouter import (
    DEFAULT_TIMEOUT_SECONDS,
    resolve_timeout_seconds,
)


class _Response:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return json.dumps(self.payload).encode()


class OpenRouterImageClientTests(unittest.TestCase):
    def test_legacy_builder_keeps_ignoring_partner_only_fields(self):
        request = build_openrouter_request(
            {
                "model": "legacy-model-id",
                "objective": "Keep the old adapter behavior.",
                "negative_prompt": "legacy ignored value",
                "output": {
                    "count": 7,
                    "seed": -1,
                    "prompt_extend": True,
                    "watermark": True,
                    "size": "1024*1024",
                    "size_mode": "auto",
                },
            }
        )

        self.assertEqual(request["model"], "legacy-model-id")
        self.assertEqual(request["n"], 7)
        self.assertEqual(request["seed"], -1)

    def test_posts_an_authenticated_image_request_and_returns_response(self):
        captured = {}

        def open_request(request, *, timeout):
            captured["authorization"] = request.get_header("Authorization")
            captured["body"] = json.loads(request.data)
            captured["timeout"] = timeout
            return _Response(
            {
                "data": [{"b64_json": "aW1hZ2U=", "media_type": "image/png"}],
                "usage": {"cost": 0.04},
            }
            )

        client = OpenRouterImageClient("test-key", opener=open_request)
        response = client.generate({"model": "meta/muse-image", "prompt": "neutral object"})

        self.assertEqual(captured["authorization"], "Bearer test-key")
        self.assertEqual(captured["body"]["prompt"], "neutral object")
        self.assertEqual(captured["timeout"], 180)
        self.assertEqual(response["usage"]["cost"], 0.04)

    def test_forwards_an_explicit_positive_finite_timeout(self):
        captured = {}

        def open_request(_request, *, timeout):
            captured["timeout"] = timeout
            return _Response({"data": []})

        client = OpenRouterImageClient(
            "test-key", opener=open_request, timeout=600.5
        )
        client.generate({"model": "meta/muse-image", "prompt": "neutral object"})

        self.assertEqual(captured["timeout"], 600.5)

    def test_rejects_invalid_timeouts_before_network_access(self):
        invalid_timeouts = (
            0,
            -1,
            True,
            float("nan"),
            float("inf"),
            float("-inf"),
            "180",
            None,
        )

        for timeout in invalid_timeouts:
            with self.subTest(timeout=timeout):
                opener = mock.Mock()
                with self.assertRaisesRegex(ValueError, "timeout"):
                    OpenRouterImageClient(
                        "test-key", opener=opener, timeout=timeout
                    )
                opener.assert_not_called()

    def test_writes_reproducible_artifacts_without_copying_base64_into_metadata(self):
        response = {
            "data": [{"b64_json": "aW1hZ2U=", "media_type": "image/png"}],
            "usage": {"cost": 0.04},
        }
        request = {"model": "qwen/qwen-image-3-pro", "prompt": "golf"}
        brief = {"objective": "Replace the flower with a golf club."}

        with tempfile.TemporaryDirectory() as directory:
            record = write_run_artifacts(Path(directory), brief, request, response)

            self.assertEqual((Path(directory) / "image-01.png").read_bytes(), b"image")
            metadata = (Path(directory) / "response.json").read_text()
            self.assertNotIn("aW1hZ2U=", metadata)
            self.assertTrue(record["outputs"][0]["sha256"].startswith("6105d6cc76af4003"))

    def test_surfaces_a_provider_error_message_without_exposing_the_key(self):
        def fail_request(request, *, timeout):
            raise urllib.error.HTTPError(
                request.full_url,
                404,
                "Not Found",
                {},
                BytesIO(b'{"error":{"message":"No endpoints found for this model"}}'),
            )

        client = OpenRouterImageClient("never-print-this-key", opener=fail_request)

        with self.assertRaisesRegex(RuntimeError, "No endpoints found for this model") as raised:
            client.generate({"model": "meta/muse-image", "prompt": "neutral object"})
        self.assertNotIn("never-print-this-key", str(raised.exception))

    def test_redacts_nested_alibaba_reference_data_from_run_metadata(self):
        request = {
            "model": "qwen-image-3.0-pro",
            "input": {
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"image": "data:image/png;base64,SECRET-BYTES"},
                            {"text": "golf"},
                        ],
                    }
                ]
            },
        }
        response = {
            "data": [{"b64_json": "aW1hZ2U=", "media_type": "image/png"}],
        }

        with tempfile.TemporaryDirectory() as directory:
            write_run_artifacts(Path(directory), {}, request, response)

            metadata = (Path(directory) / "request.json").read_text()
            self.assertNotIn("SECRET-BYTES", metadata)
            self.assertIn("[recorded separately]", metadata)

    def test_records_alibaba_prompt_and_external_provenance(self):
        request = {
            "model": "qwen-image-3.0-pro",
            "input": {
                "messages": [
                    {
                        "role": "user",
                        "content": [{"text": "SURGICAL GOLF EDIT"}],
                    }
                ]
            },
        }
        response = {
            "data": [{"b64_json": "aW1hZ2U=", "media_type": "image/png"}],
        }

        with tempfile.TemporaryDirectory() as directory:
            write_run_artifacts(
                Path(directory),
                {},
                request,
                response,
                provenance={"provider": "alibaba", "prompt_id": "prompt-123"},
            )

            self.assertEqual(
                (Path(directory) / "prompt.txt").read_text(),
                "SURGICAL GOLF EDIT\n",
            )
            run = json.loads((Path(directory) / "run.json").read_text())
            self.assertEqual(run["provenance"]["provider"], "alibaba")
            self.assertEqual(run["provenance"]["prompt_id"], "prompt-123")


if __name__ == "__main__":
    unittest.main()


class ResolveTimeoutSeconds(unittest.TestCase):
    """The CLI took the hard 180 s default because nothing passed it a timeout.

    Every generation slower than 180 s then timed out client-side while OpenRouter
    billed the finished image anyway — $3.36 of images paid for and never delivered on
    2026-08-30. The override existed, but only the ComfyUI node used it.
    """

    def setUp(self) -> None:
        self._saved = os.environ.pop("QWEN_OPENROUTER_TIMEOUT_SECONDS", None)

    def tearDown(self) -> None:
        os.environ.pop("QWEN_OPENROUTER_TIMEOUT_SECONDS", None)
        if self._saved is not None:
            os.environ["QWEN_OPENROUTER_TIMEOUT_SECONDS"] = self._saved

    def test_unset_keeps_the_default(self) -> None:
        self.assertEqual(resolve_timeout_seconds(), float(DEFAULT_TIMEOUT_SECONDS))

    def test_a_longer_timeout_is_honoured(self) -> None:
        os.environ["QWEN_OPENROUTER_TIMEOUT_SECONDS"] = "1200"
        self.assertEqual(resolve_timeout_seconds(), 1200.0)

    def test_nothing_can_disable_the_timeout(self) -> None:
        for bad in ("0", "-5", "abc", "inf", "nan", "  "):
            with self.subTest(bad=bad):
                os.environ["QWEN_OPENROUTER_TIMEOUT_SECONDS"] = bad
                self.assertEqual(resolve_timeout_seconds(), float(DEFAULT_TIMEOUT_SECONDS))

    def test_the_node_and_the_cli_share_one_definition(self) -> None:
        from qwen_ui_pipeline.comfyui_node import _openrouter_timeout_seconds

        os.environ["QWEN_OPENROUTER_TIMEOUT_SECONDS"] = "600"
        self.assertEqual(_openrouter_timeout_seconds(), resolve_timeout_seconds())
