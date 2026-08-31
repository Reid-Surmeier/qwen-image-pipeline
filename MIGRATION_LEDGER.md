# Migration ledger

<!-- Generated from migration/entrypoints.json by scripts/validate_migration_ledger.py. -->

This ledger records the inherited execution surfaces retained during the Conductor migration. A recorded bypass is known debt, not an approved normal path; later contraction tickets must remove it before removing its entry.

| Surface | Disposition | Replacement interface | Retirement condition |
| --- | --- | --- | --- |
| comfyui.QwenImage3Edit | retained implementation | Conductor.plan and Conductor.advance | Issue #29 migrates the node and proves saved-workflow compatibility. |
| comfyui.QwenImage3Render | retained implementation | Conductor.plan and Conductor.advance | Issue #29 migrates the node and proves saved-workflow compatibility. |
| comfyui.QwenImage3TextToImage | retained implementation | Conductor.plan and Conductor.advance | Issue #29 migrates the node and proves saved-workflow compatibility. |
| comfyui.ReferenceRegionComposite | retained implementation | Assembly.assemble | Issue #29 proves saved-workflow compatibility before direct node access is retired. |
| python-api.qwen_ui_pipeline.comfyui_workflow.build_comfyui_api_workflow | retained implementation | Generation.prepare | Issue #29 places the builder behind the versioned adapter before direct access is retired. |
| python-api.qwen_ui_pipeline.comfyui_workflow.build_comfyui_assembly_workflow | retained implementation | Assembly.assemble | Issue #29 proves equivalent deterministic Assembly before direct access is retired. |
| python-api.qwen_ui_pipeline.comfyui_workflow.build_comfyui_component_extraction_workflow | retained implementation | Assembly.assemble | Issue #29 proves equivalent deterministic extraction before direct access is retired. |
| python-api.qwen_ui_pipeline.comfyui_workflow.build_partner_edit_workflow | retained implementation | Conductor.plan | Issue #29 places saved Partner edit workflows behind Conductor planning. |
| python-api.qwen_ui_pipeline.comfyui_workflow.build_partner_text_workflow | retained implementation | Conductor.plan | Issue #29 places saved Partner text workflows behind Conductor planning. |
| python-api.qwen_ui_pipeline.providers.alibaba.AlibabaImageClient.generate | retained implementation | Generation.invoke through OpenRouter | Issue #28 removes direct Alibaba reachability after compatibility evidence is preserved. |
| python-api.qwen_ui_pipeline.providers.alibaba.build_alibaba_request | retained implementation | Generation.prepare through the OpenRouter adapter protocol | Issue #28 preserves old request-read fixtures before the direct builder is retired. |
| python-api.qwen_ui_pipeline.providers.openrouter.OpenRouterImageClient.generate | retained implementation | Generation.invoke | Issue #28 makes Generation the only caller; Issue #30 removes direct public reachability. |
| python-api.qwen_ui_pipeline.providers.openrouter.build_openrouter_request | retained implementation | Generation.prepare | Issue #28 places request construction behind the versioned adapter and preserves old read fixtures. |
| python-api.qwen_ui_pipeline.providers.openrouter.write_run_artifacts | retained implementation | Run Record.reserve and Run Record.record | Issue #28 migrates Python callers to the sole Run Record writer before removal. |
| python-api.qwen_ui_pipeline.providers.router.generate_with_provider | retained implementation | Conductor.advance | Issues #28 and #29 migrate all Python and ComfyUI callers; Issue #30 removes the bypass. |
| python-api.qwen_ui_pipeline.providers.vision.OpenRouterVisionClient.review | retained implementation | Review semantic gate through Conductor-authorized evidence | Issue #30 removes direct public reachability after independent review is behind the reviewed Run path. |
| python-cli.capacity | retained implementation | qwen_ui_pipeline.capacity:main diagnostic interface | Retain while capacity planning remains provider-free and outside normal Run execution. |
| python-cli.generate | retained implementation | Conductor.plan and Conductor.advance | Issue #28 migrates the Python CLI caller and proves saved-input compatibility. |

## Additive Conductor compatibility surfaces

These new version-1 surfaces delegate to Conductor now. The inherited callers above remain recorded bypasses until Issues #28 and #29 switch them to these surfaces.

| Surface | Retirement condition |
| --- | --- |
| comfyui.QwenImage3Edit | Issue #29 migrates the ComfyUI node and proves saved-workflow compatibility. |
| comfyui.QwenImage3Render | Issue #29 migrates the ComfyUI node and proves saved-workflow compatibility. |
| comfyui.QwenImage3TextToImage | Issue #29 migrates the ComfyUI node and proves saved-workflow compatibility. |
| python-cli.generate | Issue #28 migrates the Python CLI caller and proves saved-input compatibility. |

## Direct-provider bypasses still present

| Call path | Replacement interface | Retirement condition |
| --- | --- | --- |
| qwen_ui_pipeline/cli.py:main->generate_with_provider | Conductor.advance | Issue #28 migrates the Python CLI caller. |
| qwen_ui_pipeline/comfyui_node.py:QwenImage3Render.render->generate_with_provider | Conductor.advance | Issue #29 migrates the saved-workflow-compatible node. |
| qwen_ui_pipeline/comfyui_node.py:_partner_render->generate_with_provider | Conductor.advance | Issue #29 migrates both Partner-compatible nodes. |
| qwen_ui_pipeline/providers/alibaba.py:AlibabaImageClient.generate->self._opener | Generation.invoke through OpenRouter | Issue #28 removes the direct Alibaba client after captured compatibility evidence is preserved. |
| qwen_ui_pipeline/providers/openrouter.py:OpenRouterImageClient.generate->self._opener | Generation.invoke | Issue #28 makes Generation the sole caller of the OpenRouter transport. |
| qwen_ui_pipeline/providers/router.py:generate_with_provider->alibaba_client.generate | Generation.invoke through OpenRouter | Issue #28 removes the direct Alibaba route. |
| qwen_ui_pipeline/providers/router.py:generate_with_provider->openrouter_client.generate | Generation.invoke | Issue #28 makes Generation the only provider adapter caller. |
| qwen_ui_pipeline/providers/vision.py:OpenRouterVisionClient.review->self._opener | Review semantic gate through Conductor-authorized evidence | Issue #30 removes direct public reachability after the reviewed Run path owns invocation. |
