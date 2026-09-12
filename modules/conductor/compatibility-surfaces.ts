/* Generated from migration/entrypoints.json by scripts/validate_migration_ledger.py. */

export const COMPATIBILITY_RETIREMENT_CONDITIONS = Object.freeze({
  "comfyui.QwenImage3Edit": "Issue #29 migrates the ComfyUI node and proves saved-workflow compatibility.",
  "comfyui.QwenImage3Render": "Issue #29 migrates the ComfyUI node and proves saved-workflow compatibility.",
  "comfyui.QwenImage3TextToImage": "Issue #29 migrates the ComfyUI node and proves saved-workflow compatibility.",
  "python-cli.generate": "Issue #30 may remove the deprecated command after saved-input callers adopt Conductor plan and advance.",
} as const)

export type CompatibilitySurface = keyof typeof COMPATIBILITY_RETIREMENT_CONDITIONS
