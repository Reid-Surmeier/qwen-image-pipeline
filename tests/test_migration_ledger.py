from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "validate_migration_ledger.py"


def _load_validator():
    spec = importlib.util.spec_from_file_location("validate_migration_ledger", SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError("migration-ledger validator could not be loaded")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class MigrationLedgerTests(unittest.TestCase):
    def test_ledger_classifies_every_retained_execution_surface_and_known_bypass(self) -> None:
        validator = _load_validator()
        errors, document = validator.validate_repository(ROOT)
        self.assertEqual(errors, [])
        self.assertEqual(document["schemaVersion"], 1)

        recorded_surfaces = {entry["surface"] for entry in document["entries"]}
        self.assertEqual(recorded_surfaces, validator.discover_retained_surfaces(ROOT))

        recorded_bypasses = {
            entry["path"] for entry in document["directProviderBypasses"]
        }
        self.assertEqual(recorded_bypasses, validator.discover_direct_provider_bypasses(ROOT))
        self.assertIn(
            "qwen_ui_pipeline/cli.py:main->generate_with_provider",
            recorded_bypasses,
        )

    def test_generated_human_ledger_is_current(self) -> None:
        validator = _load_validator()
        document = json.loads((ROOT / "migration/entrypoints.json").read_text(encoding="utf-8"))
        self.assertEqual(
            (ROOT / "MIGRATION_LEDGER.md").read_text(encoding="utf-8"),
            validator.render_markdown(document),
        )

    def test_unclassified_direct_submission_is_rejected(self) -> None:
        validator = _load_validator()
        with tempfile.TemporaryDirectory() as directory:
            repository = Path(directory)
            target = repository / "qwen_ui_pipeline/providers/router.py"
            target.parent.mkdir(parents=True)
            target.write_text(
                "def stray(client, request):\n    return client.generate(request)\n",
                encoding="utf-8",
            )
            self.assertEqual(
                validator.discover_direct_provider_bypasses(repository),
                {"qwen_ui_pipeline/providers/router.py:stray->client.generate"},
            )


if __name__ == "__main__":
    unittest.main()
