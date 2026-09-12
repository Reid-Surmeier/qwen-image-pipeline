import os
import unittest
import urllib.error
import json

from qwen_ui_pipeline import AlibabaImageClient, build_alibaba_request


class _Response:
    def __init__(self, body, content_type="application/json"):
        self.body = body
        self.headers = {"Content-Type": content_type}

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return self.body


class AlibabaImageClientTests(unittest.TestCase):
    def test_builds_direct_i2i_request_with_provider_specific_model_and_size(self):
        brief = {
            "objective": "Replace the flower with a golf club.",
            "output": {
                "resolution": "1K",
                "aspect_ratio": "4:3",
                "count": 4,
                "seed": 1786,
            },
        }

        request = build_alibaba_request(
            brief,
            reference_urls=["data:image/png;base64,AAAA"],
        )

        self.assertEqual(request["model"], "qwen-image-3.0-pro")
        content = request["input"]["messages"][0]["content"]
        self.assertEqual(content[0]["image"], "data:image/png;base64,AAAA")
        self.assertIn("golf club", content[-1]["text"])
        self.assertEqual(request["parameters"]["size"], "1152*864")
        self.assertEqual(request["parameters"]["prompt_extend_mode"], "direct")
        self.assertEqual(request["parameters"]["n"], 4)

    def test_preserves_a_reference_aspect_ratio_with_an_explicit_output_size(self):
        brief = {
            "objective": "Replace the flower with a golf club.",
            "output": {
                "resolution": "1K",
                "aspect_ratio": "source",
                "size": "948*806",
                "count": 4,
            },
        }

        request = build_alibaba_request(brief)

        self.assertEqual(request["parameters"]["size"], "948*806")

    def test_honors_partner_prompt_expansion_watermark_and_negative_prompt(self):
        brief = {
            "interface": {"name": "partner-compatible", "version": 1},
            "objective": "Edit Image 1.",
            "negative_prompt": "no extra text",
            "output": {
                "size_mode": "auto",
                "count": 2,
                "prompt_extend": False,
                "watermark": True,
            },
        }

        request = build_alibaba_request(brief)

        self.assertNotIn("size", request["parameters"])
        self.assertFalse(request["parameters"]["prompt_extend"])
        self.assertTrue(request["parameters"]["watermark"])
        self.assertEqual(request["parameters"]["negative_prompt"], "no extra text")

    def test_rejects_an_explicit_size_outside_the_documented_pixel_range(self):
        brief = {
            "objective": "Replace the flower with a golf club.",
            "output": {
                "resolution": "1K",
                "aspect_ratio": "source",
                "size": "300*300",
                "count": 1,
            },
        }

        with self.assertRaisesRegex(ValueError, "pixel area"):
            build_alibaba_request(brief)

    def test_validates_count_and_seed_before_alibaba_submission(self):
        for output, message in (
            ({"count": 7}, "count"),
            ({"seed": -1}, "Seed"),
        ):
            with self.subTest(output=output), self.assertRaisesRegex(ValueError, message):
                build_alibaba_request(
                    {
                        "interface": {"name": "partner-compatible", "version": 1},
                        "objective": "Render a monochrome interface.",
                        "output": output,
                    }
                )

    def test_legacy_builder_keeps_permissive_defaults_and_ignored_fields(self):
        request = build_alibaba_request(
            {
                "objective": "Keep the old adapter behavior.",
                "negative_prompt": "legacy ignored value",
                "output": {
                    "count": 7,
                    "seed": -1,
                    "prompt_extend": False,
                    "watermark": True,
                    "size_mode": "auto",
                },
            }
        )

        self.assertEqual(request["parameters"]["n"], 7)
        self.assertEqual(request["parameters"]["seed"], -1)
        self.assertTrue(request["parameters"]["prompt_extend"])
        self.assertFalse(request["parameters"]["watermark"])
        self.assertEqual(request["parameters"]["size"], "2048*1152")
        self.assertNotIn("negative_prompt", request["parameters"])



if __name__ == "__main__":
    unittest.main()


class AlibabaTimeout(unittest.TestCase):
    """The Alibaba client had a literal ``timeout=180`` inside generate().

    Nothing had ever run a long job through this path, so it went unnoticed until the
    OpenRouter upstream started refusing and the batch switched providers: the first
    Alibaba Asset Pass died at 183 s with nothing returned, 2026-08-30. Same failure as
    the OpenRouter client, same fix, and now the same shared helper.
    """

    def setUp(self) -> None:
        self._saved = os.environ.pop("QWEN_OPENROUTER_TIMEOUT_SECONDS", None)

    def tearDown(self) -> None:
        os.environ.pop("QWEN_OPENROUTER_TIMEOUT_SECONDS", None)
        if self._saved is not None:
            os.environ["QWEN_OPENROUTER_TIMEOUT_SECONDS"] = self._saved

    def _capture(self):
        seen = {}

        def opener(request, timeout=None):
            seen["timeout"] = timeout
            raise urllib.error.URLError("stop here")

        return seen, opener
