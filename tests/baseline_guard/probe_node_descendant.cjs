"use strict";

try {
  require("node:child_process").spawnSync("curl", ["--version"]);
} catch (error) {
  if (error.message.includes("descendant process is disabled")) {
    process.stdout.write("descendant process is disabled in the deterministic baseline\n");
    process.exit(0);
  }
  throw error;
}
throw new Error("descendant process escaped the deterministic baseline");
