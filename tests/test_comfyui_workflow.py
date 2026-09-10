import json
import unittest
from pathlib import Path

from qwen_ui_pipeline import (
    build_comfyui_api_workflow,
    build_comfyui_assembly_workflow,
    build_comfyui_component_extraction_workflow,
    build_partner_edit_workflow,
    build_partner_text_workflow,
)


class ComfyUiWorkflowTests(unittest.TestCase):
    def test_builds_reference_edit_graph_with_save_node(self):
        brief = {"objective": "Replace the flower with a golf club."}

        workflow = build_comfyui_api_workflow(
            brief,
            reference_filename="plantstudio-main-window.gif",
            filename_prefix="golf-ui/club-preview/v001",
        )

        self.assertEqual(workflow["1"]["class_type"], "LoadImage")
        self.assertEqual(workflow["2"]["class_type"], "QwenImage3Render")
        self.assertEqual(workflow["2"]["inputs"]["reference_images"], ["1", 0])
        self.assertEqual(workflow["3"]["inputs"]["images"], ["2", 0])
        self.assertEqual(
            workflow["3"]["inputs"]["filename_prefix"],
            "golf-ui/club-preview/v001",
        )

    def test_builds_deterministic_region_assembly_graph(self):
        workflow = build_comfyui_assembly_workflow(
            reference_filename="plantstudio-main-window.gif",
            generated_filename="golf-club-v002-2.png",
            region="182,78,37,165",
            filename_prefix="golf-ui/club-assembly/v003",
        )

        self.assertEqual(workflow["1"]["class_type"], "LoadImage")
        self.assertEqual(workflow["2"]["class_type"], "LoadImage")
        self.assertEqual(workflow["3"]["class_type"], "ReferenceRegionComposite")
        self.assertEqual(workflow["3"]["inputs"]["reference_images"], ["1", 0])
        self.assertEqual(workflow["3"]["inputs"]["generated_images"], ["2", 0])
        self.assertEqual(workflow["3"]["inputs"]["region"], "182,78,37,165")
        self.assertEqual(workflow["4"]["inputs"]["images"], ["3", 0])

    def test_builds_three_reference_partner_graph_with_visible_preview_and_save(self):
        workflow = build_partner_edit_workflow(
            reference_filenames=["layout.png", "style.png", "asset.png"],
            filename_prefix="partner/edit-preview",
            provider="openrouter",
            prompt="Use @Image1 layout, @Image2 style, and @Image3 asset.",
        )

        self.assertEqual(
            [workflow[str(index)]["class_type"] for index in range(1, 4)],
            ["LoadImage", "LoadImage", "LoadImage"],
        )
        self.assertEqual(workflow["4"]["class_type"], "QwenImage3Edit")
        self.assertEqual(workflow["4"]["inputs"]["image_1"], ["1", 0])
        self.assertEqual(workflow["4"]["inputs"]["image_2"], ["2", 0])
        self.assertEqual(workflow["4"]["inputs"]["image_3"], ["3", 0])
        for node_id, load_id in zip(("5", "6", "7"), ("1", "2", "3")):
            self.assertEqual(workflow[node_id]["class_type"], "PreviewImage")
            self.assertEqual(workflow[node_id]["inputs"]["images"], [load_id, 0])
        self.assertEqual(workflow["8"]["class_type"], "PreviewImage")
        self.assertEqual(workflow["9"]["class_type"], "SaveImage")
        self.assertEqual(workflow["8"]["inputs"]["images"], ["4", 0])
        self.assertEqual(workflow["9"]["inputs"]["images"], ["4", 0])

    def test_builds_text_partner_graph_with_visible_preview_and_save(self):
        workflow = build_partner_text_workflow(
            filename_prefix="partner/text-preview",
            provider="openrouter",
            prompt="A monochrome interface.",
        )

        self.assertEqual(workflow["1"]["class_type"], "QwenImage3TextToImage")
        self.assertEqual(workflow["2"]["class_type"], "PreviewImage")
        self.assertEqual(workflow["3"]["class_type"], "SaveImage")
        self.assertEqual(workflow["2"]["inputs"]["images"], ["1", 0])
        self.assertEqual(workflow["3"]["inputs"]["images"], ["1", 0])

    def test_partner_workflow_requires_exactly_three_portable_references(self):
        with self.assertRaisesRegex(ValueError, "exactly three"):
            build_partner_edit_workflow(
                reference_filenames=["only-one.png"],
                filename_prefix="partner/edit-preview",
                provider="alibaba",
                prompt="Edit @Image1.",
            )

    def test_saved_canvas_exposes_three_named_load_preview_lanes(self):
        path = Path("tests/fixtures/historical/workflows/partner-three-reference.workflow.json")
        canvas = json.loads(path.read_text(encoding="utf-8"))
        nodes = {node["id"]: node for node in canvas["nodes"]}

        self.assertEqual(nodes[4]["type"], "QwenImage3Edit")
        self.assertEqual(
            [item["name"] for item in nodes[4]["inputs"]],
            ["image_1", "image_2", "image_3"],
        )
        self.assertEqual(
            [group["title"].split(" — ", 1)[0] for group in canvas["groups"]],
            ["image_1", "image_2", "image_3"],
        )
        for preview_id in (5, 6, 7, 8):
            self.assertEqual(nodes[preview_id]["type"], "PreviewImage")

    def test_saved_canvases_survive_a_json_reopen_round_trip(self):
        for path in (
            Path("tests/fixtures/historical/workflows/partner-text-to-image.workflow.json"),
            Path("tests/fixtures/historical/workflows/partner-three-reference.workflow.json"),
        ):
            with self.subTest(path=path):
                original = json.loads(path.read_text(encoding="utf-8"))
                reopened = json.loads(json.dumps(original))

                self.assertEqual(reopened["nodes"], original["nodes"])
                self.assertEqual(reopened["links"], original["links"])
                self.assertGreater(len(reopened["nodes"]), 0)

    def test_extracts_reference_components_without_regenerating_their_pixels(self):
        workflow = build_comfyui_component_extraction_workflow(
            reference_filename="golfstudio-approved-baseline.png",
            components={
                "toolbar": (10, 44, 101, 25),
                "animate": (393, 350, 77, 26),
            },
            filename_prefix="golf-ui/reference-components/v001",
        )

        self.assertEqual(workflow["1"]["class_type"], "LoadImage")
        crop_nodes = [node for node in workflow.values() if node["class_type"] == "ImageCrop"]
        self.assertEqual(len(crop_nodes), 2)
        self.assertEqual(
            crop_nodes[0]["inputs"],
            {"image": ["1", 0], "x": 10, "y": 44, "width": 101, "height": 25},
        )
        save_nodes = [node for node in workflow.values() if node["class_type"] == "SaveImage"]
        self.assertEqual(
            save_nodes[0]["inputs"]["filename_prefix"],
            "golf-ui/reference-components/v001/toolbar",
        )

    def test_rejects_invalid_component_rectangles(self):
        for bad in ({"toolbar": (-1, 0, 10, 10)}, {"toolbar": (0, 0, 0, 10)}):
            with self.assertRaises(ValueError):
                build_comfyui_component_extraction_workflow(
                    reference_filename="golfstudio-approved-baseline.png",
                    components=bad,
                    filename_prefix="golf-ui/reference-components/v001",
                )


if __name__ == "__main__":
    unittest.main()
