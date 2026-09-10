import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { Effect } from "effect"
import { MediaInspectionError } from "./errors.js"
import type { MediaInspectorService } from "./types.js"

// The callable host passes its already verified artifact root. No application code is imported.
export const pythonImageInspector = (toolRoot: string): MediaInspectorService => ({
  inspect: snapshot => Effect.try({
    try: () => {
      const result = spawnSync("/usr/bin/python3", ["-I", join(toolRoot, "qwen_ui_pipeline/inspect_image.py")], {
        input: snapshot.bytes, env: { PATH: "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1" }, maxBuffer: 4096, timeout: 30000,
      })
      if (result.status !== 0) throw new Error("image decode failed")
      const decoded = JSON.parse(result.stdout.toString("utf8"))
      if (Object.keys(decoded).sort().join(",") !== "height,kind,mediaType,width" || decoded.kind !== "image" ||
          !["image/png", "image/jpeg", "image/webp"].includes(decoded.mediaType) ||
          !Number.isSafeInteger(decoded.width) || decoded.width < 1 || !Number.isSafeInteger(decoded.height) || decoded.height < 1) throw new Error("invalid media receipt")
      return decoded
    }, catch: () => new MediaInspectionError("MALFORMED_MEDIA"),
  }),
})
