import importlib.util
import sys
import json
import shutil
import struct
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).resolve().parent / "fixtures" / "historical" / "scripts" / "issue72_aspect_text.py"
SPEC = importlib.util.spec_from_file_location("issue72_aspect_text", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
dependency_spec = importlib.util.spec_from_file_location("scripts.issue53_seed_variance", SCRIPT.with_name("issue53_seed_variance.py"))
dependency = importlib.util.module_from_spec(dependency_spec)
dependency_spec.loader.exec_module(dependency)
with mock.patch.dict(sys.modules, {"scripts.issue53_seed_variance": dependency}):
    SPEC.loader.exec_module(MODULE)


class Issue72AspectTextTest(unittest.TestCase):
    def _png_dimensions(self, path):
        header = Path(path).read_bytes()[:24]
        self.assertEqual(header[:8], b"\x89PNG\r\n\x1a\n")
        self.assertEqual(header[12:16], b"IHDR")
        return struct.unpack(">II", header[16:24])

    def _copy_prepared_packet(self, destination):
        destination = Path(destination)
        for name in ("plan.json", "brief-4x3.json", "prompt.txt"):
            shutil.copy2(MODULE.OUT / name, destination / name)

    def test_preregistered_seeds_are_first_four_completed_issue53_seeds(self):
        self.assertEqual(MODULE.SEEDS, (11, 733, 4242, 20260826))
        self.assertEqual(set(MODULE.SEEDS), set(MODULE.INHERITED))
        for seed, record in MODULE.INHERITED.items():
            self.assertEqual(MODULE._sha256(MODULE.ROOT / record["file"]), record["sha256"])

    def test_aspect_arms_change_only_aspect_ratio_for_each_seed(self):
        for seed in MODULE.SEEDS:
            with self.subTest(seed=seed):
                near = MODULE.request_for(seed, "5:4", include_reference=False)
                mismatch = MODULE.request_for(seed, "4:3", include_reference=False)
                self.assertEqual(near["aspect_ratio"], "5:4")
                self.assertEqual(mismatch["aspect_ratio"], "4:3")
                near.pop("aspect_ratio")
                mismatch.pop("aspect_ratio")
                self.assertEqual(near, mismatch)

    def test_exclusive_attempt_creation_cannot_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "attempt.json"
            with mock.patch.object(MODULE.os, "fsync") as fsync:
                MODULE._create_json_exclusive(path, {"status": "reserved"})
            self.assertEqual(fsync.call_count, 2)
            with self.assertRaises(FileExistsError):
                MODULE._create_json_exclusive(path, {"status": "overwritten"})
            self.assertEqual(json.loads(path.read_text()), {"status": "reserved"})

    def test_prepared_packet_is_immutable_and_request_bound(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            with mock.patch.object(MODULE, "OUT", out):
                MODULE.prepare()
                MODULE.prepare()
                plan = json.loads((out / "plan.json").read_text(encoding="utf-8"))
                for seed in MODULE.SEEDS:
                    request = MODULE.request_for(seed)
                    request_sha256, client_request_id = MODULE._request_identity(
                        request, seed
                    )
                    self.assertEqual(
                        plan["new_arm"]["requests"][str(seed)],
                        {
                            "client_request_id": client_request_id,
                            "request_sha256": request_sha256,
                        },
                    )
                (out / "prompt.txt").write_text("changed\n", encoding="utf-8")
                with self.assertRaisesRegex(RuntimeError, "immutable"):
                    MODULE.prepare()

    def test_ambiguous_attempt_blocks_later_seed_before_network(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            (out / "plan.json").write_text("{}\n", encoding="utf-8")
            (out / "attempts").mkdir()
            (out / "attempts" / "seed-11-4x3.json").write_text(
                json.dumps({"status": "ambiguous-provider-error"}), encoding="utf-8"
            )
            with mock.patch.object(MODULE, "OUT", out), mock.patch.dict(
                "os.environ", {"OPENROUTER_API_KEY": "test-only"}
            ), mock.patch.object(MODULE.OpenRouterImageClient, "generate") as generate:
                with self.assertRaisesRegex(SystemExit, "blocks every later seed"):
                    MODULE.submit(733)
                generate.assert_not_called()

    def test_provider_failure_is_ambiguous_and_retains_global_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            self._copy_prepared_packet(out)
            with mock.patch.object(MODULE, "OUT", out), mock.patch.dict(
                "os.environ", {"OPENROUTER_API_KEY": "test-only"}
            ), mock.patch.object(
                MODULE.OpenRouterImageClient,
                "generate",
                side_effect=TimeoutError("test timeout"),
            ):
                with self.assertRaisesRegex(SystemExit, "may be billed"):
                    MODULE.submit(11)
            attempt = json.loads(
                (out / "attempts" / "seed-11-4x3.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(attempt["status"], "ambiguous-provider-error")
            self.assertTrue((out / "image-submission.lock").exists())

    def test_unexpected_output_count_is_ambiguous_and_retains_global_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            self._copy_prepared_packet(out)
            response = {"data": [], "usage": {"cost": 0.043}}
            with mock.patch.object(MODULE, "OUT", out), mock.patch.dict(
                "os.environ", {"OPENROUTER_API_KEY": "test-only"}
            ), mock.patch.object(
                MODULE.OpenRouterImageClient, "generate", return_value=response
            ):
                with self.assertRaisesRegex(SystemExit, "unexpected output count"):
                    MODULE.submit(11)
            attempt = json.loads(
                (out / "attempts" / "seed-11-4x3.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(attempt["status"], "ambiguous-output-count")
            self.assertTrue((out / "image-submission.lock").exists())

    def test_persistence_failure_is_ambiguous_and_retains_global_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            self._copy_prepared_packet(out)
            response = {"data": [{"b64_json": "AAAA"}], "usage": {"cost": 0.043}}
            with mock.patch.object(MODULE, "OUT", out), mock.patch.dict(
                "os.environ", {"OPENROUTER_API_KEY": "test-only"}
            ), mock.patch.object(
                MODULE.OpenRouterImageClient, "generate", return_value=response
            ), mock.patch.object(
                MODULE, "write_run_artifacts", side_effect=OSError("disk full")
            ):
                with self.assertRaisesRegex(SystemExit, "persistence failed"):
                    MODULE.submit(11)
            attempt = json.loads(
                (out / "attempts" / "seed-11-4x3.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(attempt["status"], "ambiguous-persistence-error")
            self.assertTrue((out / "image-submission.lock").exists())

    def test_completed_persistence_releases_global_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            self._copy_prepared_packet(out)
            response = {"data": [{"b64_json": "AAAA"}], "usage": {"cost": 0.043}}
            with mock.patch.object(MODULE, "OUT", out), mock.patch.dict(
                "os.environ", {"OPENROUTER_API_KEY": "test-only"}
            ), mock.patch.object(
                MODULE.OpenRouterImageClient, "generate", return_value=response
            ), mock.patch.object(
                MODULE, "write_run_artifacts", return_value={"usage": {"cost": 0.043}}
            ):
                MODULE.submit(11)
            attempt = json.loads(
                (out / "attempts" / "seed-11-4x3.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(attempt["status"], "completed")
            self.assertFalse((out / "image-submission.lock").exists())

    def test_incremental_estimate_is_four_new_outputs(self):
        self.assertEqual(MODULE.INCREMENTAL_ESTIMATE_USD, 0.172)
        self.assertEqual(len(MODULE.SEEDS), 4)

    def test_completed_new_outputs_have_native_provenance_and_cost(self):
        for seed in MODULE.SEEDS:
            with self.subTest(seed=seed):
                attempt_path = (
                    MODULE.OUT / "attempts" / f"seed-{seed}-4x3.json"
                )
                run_dir = MODULE.OUT / "runs" / f"seed-{seed}-4x3"
                attempt = json.loads(attempt_path.read_text(encoding="utf-8"))
                run = json.loads((run_dir / "run.json").read_text(encoding="utf-8"))
                output = run["outputs"][0]

                self.assertEqual(attempt["status"], "completed")
                self.assertEqual(attempt["completed_outputs"], 1)
                self.assertEqual(run["usage"]["cost"], 0.043)
                self.assertEqual(run["provenance"]["seed"], seed)
                self.assertEqual(
                    run["provenance"]["client_request_id"],
                    attempt["client_request_id"],
                )
                self.assertEqual(
                    run["provenance"]["request_sha256"],
                    attempt["request_sha256"],
                )
                image_path = run_dir / output["file"]
                self.assertEqual(MODULE._sha256(image_path), output["sha256"])
                self.assertEqual(self._png_dimensions(image_path), (1024, 768))

    def test_bounded_review_records_null_incidence(self):
        review = json.loads(
            (MODULE.OUT / "bounded-advisory-review.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertFalse(review["conclusion"]["clean_separation"])
        self.assertFalse(review["conclusion"]["taxonomy_change_supported"])
        self.assertEqual(review["manifest"]["declared_identities_verified"], 27)
        for arm in ("5x4", "4x3"):
            for region in ("title-bar", "species-list"):
                self.assertEqual(
                    review["incidence"][arm][region],
                    {"present": 4, "reviewed": 4},
                )

    def test_figjam_delivery_is_one_native_image_node_per_source(self):
        placement = json.loads(
            (MODULE.OUT / "figjam-placement.json").read_text(encoding="utf-8")
        )
        self.assertEqual(placement["status"], "completed")
        self.assertEqual(placement["sessionId"], "issue-72-aspect-text")
        self.assertEqual(placement["layout"]["visibleTextCount"], 0)
        self.assertEqual(placement["layout"]["resolution"], "native")
        self.assertEqual(placement["layout"]["columns"], 2)
        self.assertTrue(placement["readback"]["nodeIdsPresent"])
        self.assertFalse(placement["readback"]["prohibitedVisibleChromePresent"])
        self.assertEqual(
            [upload["nodeId"] for upload in placement["uploads"]],
            [
                "46:2",
                "46:3",
                "46:4",
                "46:5",
                "46:6",
                "46:7",
                "46:8",
                "46:9",
            ],
        )
        self.assertEqual(
            [(source["width"], source["height"]) for source in placement["sources"]],
            [(1024, 820), (1024, 768)] * 4,
        )
        self.assertEqual(
            [(item["width"], item["height"]) for item in placement["placements"]],
            [(1024, 820), (1024, 768)] * 4,
        )


if __name__ == "__main__":
    unittest.main()
