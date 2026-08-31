"use strict";

const { spawnSync } = require("node:child_process");

const arguments_ = [
  "-nostdin", "-hide_banner", "-loglevel", "error", "-xerror", "-threads", "1",
  "-protocol_whitelist", "pipe", "-i", "pipe:0", "-map", "0:v:0", "-map", "0:a?",
  "-f", "null", "-",
];
const options = {
  input: Buffer.alloc(0),
  timeout: 15_000,
  maxBuffer: 1_048_576,
  env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
  windowsHide: true,
};

const decode = spawnSync("/usr/bin/ffmpeg", arguments_, options);
if (decode.error) throw decode.error;

try {
  spawnSync("/usr/bin/ffmpeg", [...arguments_.slice(0, 9), "https", ...arguments_.slice(10)], options);
} catch (error) {
  if (error.message.includes("descendant process is disabled")) {
    process.stdout.write("exact offline decoder allowed; changed invocation blocked\n");
    process.exit(0);
  }
  throw error;
}
throw new Error("changed decoder invocation escaped the deterministic baseline");
