import hashlib
import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1] / "tests/fixtures/historical"
RUN = ROOT / "artifacts/issue-32/partner-side-by-side-v001"


def _load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class Issue32PartnerSideBySideEvidenceTests(unittest.TestCase):
    def test_paid_matrix_is_complete_and_bounded(self):
        comparison = _load_json(RUN / "comparison.json")

        self.assertEqual(comparison["provider"], "openrouter")
        self.assertEqual(comparison["model"], "qwen/qwen-image-3-pro")
        self.assertEqual(comparison["requested_outputs"], 2)
        self.assertEqual(comparison["completed_outputs"], 2)
        self.assertEqual(comparison["possibly_billed_outputs"], 0)
        self.assertEqual(comparison["actual_cost_usd"], 0.086)
        self.assertFalse(comparison["paid_ci"])
        self.assertEqual(len(comparison["arms"]), 2)
        self.assertTrue(
            all(arm["status"] == "success" for arm in comparison["arms"])
        )
        self.assertEqual(
            len({arm["attempt_id"] for arm in comparison["arms"]}), 2
        )

        execution = _load_json(RUN / "execution.json")
        self.assertEqual(len(execution["attempts"]), 2)
        self.assertEqual(
            execution["code_base_commit"],
            "1b600571a36dc4671efaafabe374216b1afc3357",
        )
        self.assertIn("untracked", execution["code_state_note"])

    def test_node_paths_persist_identical_sanitized_provider_requests(self):
        plan = _load_json(RUN / "plan.json")
        legacy = (RUN / "legacy.request.json").read_bytes()
        partner = (RUN / "partner.request.json").read_bytes()

        self.assertTrue(plan["reference_node_encodings_identical"])
        self.assertTrue(plan["sanitized_requests_identical"])
        self.assertEqual(legacy, partner)
        self.assertNotIn(b"data:image", legacy)
        self.assertNotIn(b"base64,", legacy)

    def test_native_outputs_match_their_provenance_hashes(self):
        comparison = _load_json(RUN / "comparison.json")

        for arm in comparison["arms"]:
            output = ROOT / arm["output"]["path"]
            self.assertTrue(output.is_file())
            self.assertEqual(_sha256(output), arm["output"]["sha256"])
            self.assertEqual(arm["output"]["size"], [1024, 1024])

        self.assertFalse(comparison["comparison"]["same_output_sha256"])
        self.assertTrue(comparison["comparison"]["same_dimensions"])

    def test_offline_actual_node_replay_matches_the_paid_requests_and_outputs(self):
        replay = _load_json(RUN / "node-replay.json")

        self.assertEqual(replay["paid_requests"], 0)
        self.assertEqual(replay["legacy"]["node_class"], "QwenImage3Render")
        self.assertEqual(replay["partner"]["node_class"], "QwenImage3Edit")
        self.assertTrue(replay["legacy"]["matches_paid_request"])
        self.assertTrue(replay["partner"]["matches_paid_request"])
        self.assertTrue(replay["captured_requests_identical"])
        self.assertTrue(replay["outputs_match_saved_pixels"])


if __name__ == "__main__":
    unittest.main()
