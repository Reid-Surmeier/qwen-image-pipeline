from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from unittest import mock
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
        self.assertIn(
            "qwen_ui_pipeline/providers/vision.py:OpenRouterVisionClient.review->self._opener",
            recorded_bypasses,
        )

    def test_generated_human_ledger_is_current(self) -> None:
        validator = _load_validator()
        document = json.loads((ROOT / "migration/entrypoints.json").read_text(encoding="utf-8"))
        self.assertEqual(
            (ROOT / "MIGRATION_LEDGER.md").read_text(encoding="utf-8"),
            validator.render_markdown(document),
        )
        self.assertEqual(
            (ROOT / "modules/conductor/compatibility-surfaces.ts").read_text(encoding="utf-8"),
            validator.render_compatibility_typescript(document),
        )

    def test_malformed_documents_return_errors_instead_of_raising(self) -> None:
        validator = _load_validator()
        self.assertEqual(
            validator.validate_document([]),
            ["migration ledger root must be an object"],
        )
        errors = validator.validate_document(
            {
                "schemaVersion": 1,
                "entries": [{}],
                "compatibilitySurfaces": [{}],
                "directProviderBypasses": [{}],
            }
        )
        self.assertGreater(len(errors), 0)
        self.assertTrue(any("entries[0].surface" in error for error in errors))
        self.assertTrue(any("compatibilitySurfaces[0].surface" in error for error in errors))
        self.assertTrue(any("directProviderBypasses[0].path" in error for error in errors))

    def test_unclassified_direct_submission_is_rejected(self) -> None:
        validator = _load_validator()
        with tempfile.TemporaryDirectory() as directory:
            repository = Path(directory)
            target = repository / "qwen_ui_pipeline/providers/router.py"
            target.parent.mkdir(parents=True)
            target.write_text(
                "from qwen_ui_pipeline.providers.router import generate_with_provider as dispatch\n"
                "from qwen_ui_pipeline.providers import router\n"
                "def direct_client(client, request):\n    return client.generate(request)\n"
                "def qualified(brief):\n    return router.generate_with_provider(brief)\n"
                "def imported_alias(brief):\n    return dispatch(brief)\n"
                "forward = dispatch\n"
                "def assigned_alias(brief):\n    return forward(brief)\n"
                "class MovedClient:\n"
                "    def review(self, request):\n"
                "        return self._opener(request)\n"
                "def verifier(client, request):\n"
                "    return client.review(request)\n",
                encoding="utf-8",
            )
            self.assertEqual(
                validator.discover_direct_provider_bypasses(repository),
                {
                    "qwen_ui_pipeline/providers/router.py:direct_client->client.generate",
                    "qwen_ui_pipeline/providers/router.py:qualified->router.generate_with_provider",
                    "qwen_ui_pipeline/providers/router.py:imported_alias->dispatch",
                    "qwen_ui_pipeline/providers/router.py:assigned_alias->forward",
                    "qwen_ui_pipeline/providers/router.py:MovedClient.review->self._opener",
                    "qwen_ui_pipeline/providers/router.py:verifier->client.review",
                },
            )

    def test_runtime_probes_identify_every_inherited_provider_bypass(self) -> None:
        from qwen_ui_pipeline import cli, comfyui_node
        from qwen_ui_pipeline.providers.alibaba import AlibabaImageClient
        from qwen_ui_pipeline.providers.openrouter import OpenRouterImageClient
        from qwen_ui_pipeline.providers.router import ProviderResult, generate_with_provider
        from qwen_ui_pipeline.providers.vision import OpenRouterVisionClient
        from qwen_ui_pipeline.fidelity import FidelityContract, FidelityResult, MutableRegion, RegionChange
        from qwen_ui_pipeline.verifier import RegionReview, VisionClient, run_verification

        document = json.loads((ROOT / "migration/entrypoints.json").read_text(encoding="utf-8"))
        expected = {entry["path"] for entry in document["directProviderBypasses"]}
        observed: set[str] = set()

        class Response:
            def __init__(self, body: bytes):
                self.body = body
                self.headers = {"Content-Type": "application/json"}

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, *_args):
                return self.body

        class Solid:
            width = 1
            height = 1

            def convert(self, _mode):
                return self

            def resize(self, _size, _resample):
                return self

            def save(self, buffer, _format=None, **_kwargs):
                buffer.write(b"runtime-probe")

        brief = {
            "provider": "openrouter",
            "objective": "Runtime bypass inventory probe.",
            "output": {"resolution": "1K", "aspect_ratio": "1:1", "count": 1},
        }

        def legacy_result(path: str, request: dict | None = None) -> ProviderResult:
            observed.add(path)
            return ProviderResult(
                "openrouter",
                request or {"model": "qwen/qwen-image-3-pro", "resolution": "1K", "aspect_ratio": "1:1", "n": 1},
                {"data": [{"b64_json": "aW1hZ2U=", "media_type": "image/png"}]},
            )

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            brief_path = root / "brief.json"
            brief_path.write_text(json.dumps(brief), encoding="utf-8")
            with (
                mock.patch.object(
                    cli,
                    "generate_with_provider",
                    side_effect=lambda *_args, **_kwargs: legacy_result(
                        "qwen_ui_pipeline/cli.py:main->generate_with_provider"
                    ),
                ),
                mock.patch.object(cli, "write_run_artifacts", return_value={}),
            ):
                self.assertEqual(
                    cli.main(["generate", str(brief_path), "--output-dir", str(root / "run")]),
                    0,
                )

        with (
            mock.patch.object(comfyui_node, "_provider_clients", return_value=(object(), None)),
            mock.patch.object(
                comfyui_node,
                "generate_with_provider",
                side_effect=lambda *_args, **_kwargs: legacy_result(
                    "qwen_ui_pipeline/comfyui_node.py:_partner_render->generate_with_provider",
                    {"model": "qwen/qwen-image-3-pro"},
                ),
            ),
            mock.patch.object(comfyui_node, "_response_tensors", return_value="probe-image"),
        ):
            comfyui_node._partner_render(brief, [])

        with (
            mock.patch.object(comfyui_node, "_reference_data_urls", return_value=[]),
            mock.patch.object(
                comfyui_node,
                "generate_with_provider",
                side_effect=lambda *_args, **_kwargs: legacy_result(
                    "qwen_ui_pipeline/comfyui_node.py:QwenImage3Render.render->generate_with_provider"
                ),
            ),
            mock.patch.object(comfyui_node, "_response_tensors", return_value="probe-image"),
        ):
            comfyui_node.QwenImage3Render().render(json.dumps(brief))

        class ProviderClient:
            def __init__(self, path: str):
                self.path = path

            def generate(self, _request):
                observed.add(self.path)
                return {"data": []}

        generate_with_provider(
            brief,
            reference_urls=[],
            openrouter_client=ProviderClient(
                "qwen_ui_pipeline/providers/router.py:generate_with_provider->openrouter_client.generate"
            ),
        )
        generate_with_provider(
            {**brief, "provider": "alibaba"},
            reference_urls=[],
            alibaba_client=ProviderClient(
                "qwen_ui_pipeline/providers/router.py:generate_with_provider->alibaba_client.generate"
            ),
        )

        def openrouter_transport(_request, *, timeout):
            observed.add(
                "qwen_ui_pipeline/providers/openrouter.py:OpenRouterImageClient.generate->self._opener"
            )
            return Response(b'{"data":[]}')

        OpenRouterImageClient("probe-key", opener=openrouter_transport).generate(
            {"model": "qwen/qwen-image-3-pro", "prompt": "probe"}
        )

        def alibaba_transport(request, *, timeout):
            observed.add(
                "qwen_ui_pipeline/providers/alibaba.py:AlibabaImageClient.generate->self._opener"
            )
            if isinstance(request, str):
                response = Response(b"probe-image")
                response.headers = {"Content-Type": "image/png"}
                return response
            return Response(
                b'{"output":{"choices":[{"message":{"content":[{"image":"https://example.test/probe.png"}]}}]}}'
            )

        AlibabaImageClient("probe-key", opener=alibaba_transport).generate(
            {"model": "qwen-image-3.0-pro", "input": {}, "parameters": {}}
        )

        def vision_transport(_request, *, timeout):
            observed.add(
                "qwen_ui_pipeline/providers/vision.py:OpenRouterVisionClient.review->self._opener"
            )
            return Response(
                b'{"choices":[{"message":{"content":"{\\"verdict\\":\\"match\\"}"}}]}'
            )

        OpenRouterVisionClient(api_key="probe-key", _opener=vision_transport).review(
            RegionReview(region="probe", baseline_crop=Solid(), candidate_crop=Solid())
        )

        class RuntimeVisionClient(VisionClient):
            def review(self, review):
                observed.add(
                    "qwen_ui_pipeline/verifier.py:run_verification->client.review"
                )
                return {"verdict": "match"}

        run_verification(
            FidelityContract(
                width=1,
                height=1,
                approved_baseline="probe",
                mutable_regions=(MutableRegion("probe", 0, 0, 1, 1),),
            ),
            FidelityResult(
                passed=True,
                region_changes=(RegionChange("probe", 1, 1),),
                invariant_violations=(),
            ),
            Solid(),
            Solid(),
            client=RuntimeVisionClient(),
        )
        self.assertEqual(observed, expected)


if __name__ == "__main__":
    unittest.main()
