"""Public kernel acceptance for the preserved DIS request (Issue #90)."""
import base64
import io
import json
import unittest
from PIL import Image
from qwen_ui_pipeline.muse_adapter import invoke_muse_kernel
from qwen_ui_pipeline.qwen_adapter import QwenKernelError
import copy


class MuseKernelTests(unittest.TestCase):
    def test_gallery_request_is_preserved_without_qwen_prompt_or_seed(self):
        captured = []
        image = io.BytesIO()
        Image.new("RGB", (2, 1), (12, 34, 56)).save(image, "WEBP", lossless=True)

        class Client:
            def generate(self, request):
                captured.append(request)
                return {"data": [{"b64_json": base64.b64encode(image.getvalue()).decode(),
                                  "media_type": "image/png"}], "usage": {"cost": 0.01}}

        result = invoke_muse_kernel({
            "adapter_protocol_version": "1", "operation": "invoke", "provider": "openrouter",
            "model": "meta/muse-image", "objective": "A brass listening device.\n",
            "requested_count": 1, "parameters": {"size": "1760x1440"}, "references": [],
        }, client=Client())
        self.assertEqual(captured, [{"model": "meta/muse-image", "prompt": "A brass listening device.\n",
                                     "n": 1, "size": "1760x1440"}])
        receipt = json.loads(base64.b64decode(result["provider_evidence"]["body_base64"]))
        self.assertEqual(receipt["cost"], {"state": "actual", "actual_cost_usd": "0.010000"})
        self.assertIsNone(receipt["id"])
        self.assertEqual(receipt["source_images"][0]["media_type"], "image/webp")
        raster = json.loads(base64.b64decode(result["outputs"][0]["body_base64"]))
        self.assertEqual(raster, {"height": 1, "width": 2, "pixels": [12, 34, 56, 255] * 2})

    def test_invalid_requests_do_not_dispatch_and_ambiguous_dispatch_is_not_retried(self):
        request = {"adapter_protocol_version": "1", "operation": "invoke", "provider": "openrouter",
                   "model": "meta/muse-image", "objective": "Saved prompt", "requested_count": 1,
                   "parameters": {"size": "1760x1440"}, "references": []}
        calls = []
        class Client:
            def generate(self, request):
                calls.append(request)
                raise TimeoutError("possibly billed")
        mutations = [{"model":"qwen/qwen-image-3-pro"}, {"provider":"auto"},
                     {"requested_count":2}, {"parameters":{"size":"1760x1440", "seed":42}},
                     {"references":[{"slot":"missing"}]}]
        for mutation in mutations:
            candidate = copy.deepcopy(request); candidate.update(mutation)
            with self.subTest(mutation=mutation), self.assertRaises(QwenKernelError) as caught:
                invoke_muse_kernel(candidate, client=Client())
            self.assertEqual(caught.exception.code,"ADAPTER_NOT_STARTED")
        self.assertEqual(calls,[])
        with self.assertRaises(QwenKernelError) as caught:
            invoke_muse_kernel(request,client=Client())
        self.assertEqual(caught.exception.code,"PROVIDER_AMBIGUOUS")
        self.assertEqual(len(calls),1)

    def test_retired_qwen_and_direct_alibaba_make_zero_network_attempts(self):
        from unittest.mock import Mock
        from qwen_ui_pipeline.providers.openrouter import OpenRouterImageClient
        from qwen_ui_pipeline.providers.alibaba import AlibabaImageClient
        opener = Mock()
        with self.assertRaisesRegex(ValueError, "retired"):
            OpenRouterImageClient("fixture-key", opener=opener).generate({"model":"qwen/qwen-image-3-pro"})
        with self.assertRaisesRegex(RuntimeError, "retired"):
            AlibabaImageClient("fixture-key", opener=opener).generate({"model":"qwen-image-3.0-pro"})
        opener.assert_not_called()

    def test_paid_count_or_cost_mismatch_and_receipt_recovery(self):
        from qwen_ui_pipeline.muse_adapter import recover_muse_kernel
        request = {"adapter_protocol_version":"1","operation":"invoke","provider":"openrouter","model":"meta/muse-image","objective":"saved","requested_count":1,"parameters":{"size":"2x1"},"references":[]}
        image=io.BytesIO(); Image.new("RGB",(2,1),(12,34,56)).save(image,"WEBP",lossless=True)
        item={"b64_json":base64.b64encode(image.getvalue()).decode()}
        from unittest.mock import Mock
        for response in [{"data":[]},{"data":[item,item]},{"data":[item],"usage":{"cost":-1}}]:
            client=Mock(); client.generate.return_value=response
            with self.assertRaises(QwenKernelError): invoke_muse_kernel(request,client=client)
            client.generate.assert_called_once()
        client=Mock(); client.generate.return_value={"data":[item]}
        result=invoke_muse_kernel(request,client=client)
        recovery={"adapter_protocol_version":"1","operation":"recover","model":"meta/muse-image","provider_evidence":result["provider_evidence"]}
        self.assertEqual(recover_muse_kernel(recovery),result)
        client.generate.assert_called_once()
        recovery["provider_evidence"]["sha256"]="0"*64
        with self.assertRaises(QwenKernelError): recover_muse_kernel(recovery)
