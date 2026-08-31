"use strict";

const { spawnSync } = require("node:child_process");

const arguments_ = [
  "-nostdin", "-hide_banner", "-loglevel", "error", "-xerror", "-threads", "1",
  "-protocol_whitelist", "pipe", "-i", "pipe:0", "-map", "0:v:0", "-map", "0:a?",
  "-f", "framehash", "-",
];
const options = {
  input: Buffer.alloc(0),
  timeout: 15_000,
  maxBuffer: 1_048_576,
  env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
  windowsHide: true,
};

const version = spawnSync("/usr/bin/ffmpeg", ["-version"], {
  timeout: 5_000,
  maxBuffer: 65_536,
  env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
  windowsHide: true,
  encoding: "utf8",
});
if (version.error || version.status !== 0 || !/^ffmpeg version 6(?:\.|\s)/.test(version.stdout)) {
  throw new Error("FFmpeg 6 identity check failed");
}

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
