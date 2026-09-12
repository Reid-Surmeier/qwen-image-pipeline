import json
import io
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

from qwen_ui_pipeline.cli import main


class RecordComfyRunTests(unittest.TestCase):
    def test_generate_is_a_no_submission_conductor_migration_surface(self):
        brief = {"objective": "Legacy saved input remains readable."}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "brief.json"
            path.write_text(json.dumps(brief), encoding="utf-8")
            output = io.StringIO()
            original_openrouter = os.environ.get("OPENROUTER_API_KEY")
            original_alibaba = os.environ.get("DASHSCOPE_API_KEY")
            os.environ["OPENROUTER_API_KEY"] = "must-not-be-read"
            os.environ["DASHSCOPE_API_KEY"] = "must-not-be-read"
            try:
                with mock.patch(
                    "urllib.request.OpenerDirector.open",
                    side_effect=AssertionError("deprecated generate must not reach the network"),
                ), redirect_stdout(output):
                    status = main(["generate", str(path)])
            finally:
                if original_openrouter is None:
                    os.environ.pop("OPENROUTER_API_KEY", None)
                else:
                    os.environ["OPENROUTER_API_KEY"] = original_openrouter
                if original_alibaba is None:
                    os.environ.pop("DASHSCOPE_API_KEY", None)
                else:
                    os.environ["DASHSCOPE_API_KEY"] = original_alibaba

        migration = json.loads(output.getvalue())
        self.assertEqual(status, 2)
        self.assertEqual(migration["surface"], "python-cli.generate")
        self.assertEqual(migration["status"], "deprecated")
        self.assertEqual(migration["adapter_protocol_version"], "1")
        self.assertEqual(migration["replacement"], ["Conductor.plan", "Conductor.advance"])
        self.assertEqual(migration["saved_input"]["objective"], brief["objective"])

    def test_records_existing_comfy_outputs_with_provider_provenance(self):
        brief = {
            "objective": "Replace the flower with a golf club.",
            "output": {
                "resolution": "1K",
                "aspect_ratio": "source",
                "size": "948*806",
                "count": 1,
            },
        }

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            brief_path = root / "brief.json"
            brief_path.write_text(json.dumps(brief), encoding="utf-8")
            reference = root / "reference.png"
            reference.write_bytes(b"reference")
            image = root / "result.png"
            image.write_bytes(b"result")
            output = root / "run"

            status = main(
                [
                    "record-comfy",
                    str(brief_path),
                    "--provider",
                    "alibaba",
                    "--reference",
                    str(reference),
                    "--image",
                    str(image),
                    "--output-dir",
                    str(output),
                    "--prompt-id",
                    "prompt-123",
                    "--source-url",
                    "https://example.com/reference.png",
                    "--figma-file-key",
                    "figma-key",
                ]
            )

            self.assertEqual(status, 0)
            self.assertEqual((output / "image-01.png").read_bytes(), b"result")
            run = json.loads((output / "run.json").read_text())
            self.assertEqual(run["provenance"]["provider"], "alibaba")
            self.assertEqual(run["provenance"]["prompt_id"], "prompt-123")
            self.assertEqual(run["provenance"]["figma_file_key"], "figma-key")
            self.assertEqual(len(run["provenance"]["reference_sha256"]), 64)

class ComponentWorkflowTests(unittest.TestCase):
    def test_writes_an_exact_component_extraction_workflow(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            components = root / "components.json"
            components.write_text(json.dumps({"toolbar": [10, 44, 101, 25]}), encoding="utf-8")
            output = root / "workflow.json"

            status = main(
                [
                    "component-workflow",
                    "--reference-filename",
                    "golfstudio-approved-baseline.png",
                    "--components",
                    str(components),
                    "--filename-prefix",
                    "golf-ui/reference-components/v001",
                    "--output",
                    str(output),
                ]
            )

            self.assertEqual(status, 0)
            workflow = json.loads(output.read_text())
            self.assertEqual(workflow["2"]["class_type"], "ImageCrop")
            self.assertEqual(
                workflow["3"]["inputs"]["filename_prefix"],
                "golf-ui/reference-components/v001/toolbar",
            )


if __name__ == "__main__":
    unittest.main()
