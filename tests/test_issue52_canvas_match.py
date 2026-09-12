import importlib.util
import hashlib
import io
import json
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).resolve().parent / "fixtures" / "historical" / "scripts" / "issue52_canvas_match.py"
SPEC = importlib.util.spec_from_file_location("issue52_canvas_match", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class Issue52CanvasMatchTest(unittest.TestCase):
    def test_arms_change_only_geometry(self):
        requests = {
            arm: MODULE.request_for_arm(arm, include_reference=False)
            for arm in MODULE.ARMS
        }
        common = {"model", "prompt", "n", "seed"}
        baseline = {key: requests["exact-size"][key] for key in common}
        for request in requests.values():
            self.assertEqual(baseline, {key: request[key] for key in common})
            self.assertEqual(set(request) - common, set(request) & {"size", "resolution", "aspect_ratio"})
        self.assertEqual(requests["exact-size"]["size"], "948x806")
        self.assertNotIn("resolution", requests["exact-size"])
        self.assertNotIn("aspect_ratio", requests["exact-size"])
        self.assertEqual(requests["nearest-1k"]["aspect_ratio"], "5:4")
        self.assertEqual(requests["mismatch-1k"]["aspect_ratio"], "16:9")
        self.assertEqual(requests["nearest-2k"]["resolution"], "2K")

    def test_submit_refuses_existing_attempt_before_reading_secret(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            (out / "plan.json").write_text("{}\n", encoding="utf-8")
            (out / "attempts").mkdir()
            (out / "attempts" / "exact-size.json").write_text(
                json.dumps({"status": "reserved-before-submit"}), encoding="utf-8"
            )
            with mock.patch.object(MODULE, "OUT", out), mock.patch.dict(
                "os.environ", {"OPENROUTER_API_KEY": "test-only"}
            ):
                with self.assertRaisesRegex(SystemExit, "refusing resubmission"):
                    MODULE.submit("exact-size")

    def test_cost_estimate_matches_preregistered_arms(self):
        self.assertEqual(
            sum(arm["estimated_cost_usd"] for arm in MODULE.ARMS.values()),
            0.207,
        )

    def test_exclusive_json_creation_is_a_no_overwrite_sentinel(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "attempt.json"
            MODULE._create_json_exclusive(path, {"status": "reserved"})
            with self.assertRaises(FileExistsError):
                MODULE._create_json_exclusive(path, {"status": "overwritten"})
            self.assertEqual(json.loads(path.read_text()), {"status": "reserved"})

    def test_ambiguous_attempt_blocks_every_later_arm_before_network(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            (out / "plan.json").write_text("{}\n", encoding="utf-8")
            (out / "attempts").mkdir()
            (out / "attempts" / "exact-size.json").write_text(
                json.dumps({"status": "ambiguous-transport-error"}),
                encoding="utf-8",
            )
            with mock.patch.object(MODULE, "OUT", out), mock.patch.dict(
                "os.environ", {"OPENROUTER_API_KEY": "test-only"}
            ), mock.patch.object(MODULE.urllib.request, "urlopen") as urlopen:
                with self.assertRaisesRegex(SystemExit, "blocks every later arm"):
                    MODULE.submit("nearest-1k")
                urlopen.assert_not_called()

    def test_submission_lock_is_exclusive(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            with mock.patch.object(MODULE, "OUT", out):
                lock = MODULE._acquire_image_submission_lock("exact-size")
                with self.assertRaisesRegex(SystemExit, "reconcile"):
                    MODULE._acquire_image_submission_lock("nearest-1k")
                MODULE._release_image_submission_lock(lock)

    def test_http_5xx_is_ambiguous_and_keeps_global_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            (out / "plan.json").write_text("{}\n", encoding="utf-8")
            error = urllib.error.HTTPError(
                MODULE.ENDPOINT,
                503,
                "service unavailable",
                hdrs=None,
                fp=io.BytesIO(b'{"error":"temporary"}'),
            )
            with mock.patch.object(MODULE, "OUT", out), mock.patch.dict(
                "os.environ", {"OPENROUTER_API_KEY": "test-only"}
            ), mock.patch.object(
                MODULE, "request_for_arm", return_value={"model": MODULE.MODEL, "n": 1}
            ), mock.patch.object(MODULE.urllib.request, "urlopen", side_effect=error):
                with self.assertRaisesRegex(SystemExit, "keep the global lock"):
                    MODULE.submit("exact-size")
            attempt = json.loads(
                (out / "attempts" / "exact-size.json").read_text(encoding="utf-8")
            )
            self.assertEqual(attempt["status"], "ambiguous-http-server-error")
            self.assertEqual(attempt["http_status"], 503)
            self.assertTrue((out / "image-submission.lock").exists())

    def test_source_hash_is_revalidated_before_use(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.png"
            source.write_bytes(b"tampered")
            expected = hashlib.sha256(b"expected").hexdigest()
            with mock.patch.object(MODULE, "SOURCE", source), mock.patch.object(
                MODULE, "SOURCE_SHA256", expected
            ):
                with self.assertRaisesRegex(RuntimeError, "identity"):
                    MODULE._validated_source_bytes()


if __name__ == "__main__":
    unittest.main()
