"""Deterministic checks for the Issue #26 visual-failure annotation corpus.

These tests keep the annotation records honest: every record must point at a
real artifact, carry its current SHA-256, and cite only defect classes that
the versioned taxonomy actually defines. No network, no model calls.
"""

import hashlib
import json
import re
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
FIXTURES = REPO / "tests/fixtures/historical"
ANNOTATIONS = FIXTURES / "artifacts" / "issue-26" / "annotations"
TAXONOMY = REPO / "docs" / "research" / "visual-failure-taxonomy.md"

ALLOWED_ROLES = {
    "source_reference",
    "rejected_candidate",
    "approved_output",
    "comparison_evidence",
    "context_limited_example",
}
ALLOWED_DISPOSITIONS = {
    "authoritative",
    "accepted",
    "rejected",
    "evidence",
    "context_missing",
}
ALLOWED_STRENGTHS = {"hard", "strong", "weak"}


def taxonomy_class_ids():
    text = TAXONOMY.read_text(encoding="utf-8")
    return set(re.findall(r"^\| (T\d{2}) \|", text, flags=re.MULTILINE))


def annotation_records():
    paths = sorted(ANNOTATIONS.glob("*.json"))
    return [(path, json.loads(path.read_text(encoding="utf-8"))) for path in paths]


class VisualFailureAnnotationTests(unittest.TestCase):
    def test_corpus_is_present(self):
        self.assertTrue(TAXONOMY.is_file(), "taxonomy document is missing")
        records = annotation_records()
        self.assertGreaterEqual(len(records), 10, "seed corpus should keep at least 10 records")

    def test_taxonomy_defines_classes(self):
        classes = taxonomy_class_ids()
        self.assertGreaterEqual(len(classes), 15, f"unexpectedly few classes parsed: {sorted(classes)}")

    def test_records_are_valid_and_hashes_match(self):
        classes = taxonomy_class_ids()
        for path, record in annotation_records():
            with self.subTest(record=path.name):
                self.assertEqual(record["schema_version"], "annotation-v1")
                self.assertIn(record["role"], ALLOWED_ROLES)
                self.assertIn(record["disposition"], ALLOWED_DISPOSITIONS)
                self.assertTrue(record["annotator"], "annotator is required")

                artifact = FIXTURES / record["artifact_path"]
                self.assertTrue(artifact.is_file(), f"missing artifact {record['artifact_path']}")
                digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
                self.assertEqual(digest, record["sha256"], f"hash drift for {record['artifact_path']}")

                for defect in record["defects"]:
                    self.assertIn(defect["class"], classes, f"unknown class {defect['class']}")
                    self.assertIn(defect["strength"], ALLOWED_STRENGTHS)
                    self.assertTrue(defect["note"].strip())
                    if defect["region"] is not None:
                        self.assertEqual(len(defect["region"]), 4)
                        self.assertTrue(all(isinstance(v, int) and v >= 0 for v in defect["region"]))

    def test_rejections_cite_defects_and_acceptances_may_not_hard_fail(self):
        for path, record in annotation_records():
            with self.subTest(record=path.name):
                if record["disposition"] == "rejected":
                    self.assertTrue(record["defects"], "a rejection must cite at least one defect")
                if record["disposition"] == "accepted":
                    hard = [d for d in record["defects"] if d["strength"] == "hard"]
                    self.assertFalse(hard, "an accepted output cannot carry a hard-gate defect")


if __name__ == "__main__":
    unittest.main()
