import io
import json
import unittest
from unittest import mock

from qwen_ui_pipeline import qwen_adapter_host


class QwenAdapterHostTests(unittest.TestCase):
    def test_missing_logical_credential_fails_before_client_initialization(self):
        stdin = io.StringIO("{}")
        stdout = io.StringIO()
        with mock.patch.dict("os.environ", {}, clear=True), mock.patch.object(
            qwen_adapter_host.sys, "stdin", stdin
        ), mock.patch.object(qwen_adapter_host.sys, "stdout", stdout), mock.patch.object(
            qwen_adapter_host, "OpenRouterImageClient"
        ) as client:
            status = qwen_adapter_host.main()
        self.assertEqual(status, 2)
        self.assertEqual(json.loads(stdout.getvalue())["adapter_error"]["code"], "ADAPTER_NOT_STARTED")
        client.assert_not_called()

    def test_execute_uses_only_the_injected_local_dummy_client(self):
        client = mock.Mock()
        with mock.patch.object(
            qwen_adapter_host,
            "invoke_qwen_kernel",
            return_value={"adapter_protocol_version": "1"},
        ) as invoke:
            result = qwen_adapter_host.execute({"adapter_protocol_version": "1"}, client=client)
        self.assertEqual(result, {"adapter_protocol_version": "1"})
        invoke.assert_called_once_with({"adapter_protocol_version": "1"}, client=client)


if __name__ == "__main__":
    unittest.main()
