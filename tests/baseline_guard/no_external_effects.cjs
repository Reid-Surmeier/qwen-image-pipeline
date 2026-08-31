"use strict";

if (process.env.QWEN_BASELINE_OFFLINE === "1") {
  const net = require("node:net");
  const dgram = require("node:dgram");
  const childProcess = require("node:child_process");
  const originalSpawnSync = childProcess.spawnSync;

  const blockedNetwork = () => {
    throw new Error("network access is disabled in the deterministic baseline");
  };

  const blockedChild = () => {
    throw new Error("descendant process is disabled in the deterministic baseline");
  };

  const ffmpegArguments = [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-xerror", "-threads", "1",
    "-protocol_whitelist", "pipe", "-i", "pipe:0", "-map", "0:v:0", "-map", "0:a?",
    "-f", "null", "-",
  ];
  const isExactFfmpegDecode = (file, arguments_, options) => {
    if (
      file !== "/usr/bin/ffmpeg" ||
      !Array.isArray(arguments_) ||
      arguments_.length !== ffmpegArguments.length ||
      arguments_.some((argument, index) => argument !== ffmpegArguments[index]) ||
      options === null || typeof options !== "object" || Array.isArray(options) ||
      !(options.input instanceof Uint8Array) ||
      options.timeout !== 15_000 || options.maxBuffer !== 1_048_576 ||
      options.windowsHide !== true
    ) return false;
    const environment = options.env;
    return environment !== null && typeof environment === "object" && !Array.isArray(environment) &&
      Object.keys(environment).sort().join(",") === "LANG,LC_ALL,PATH" &&
      environment.LANG === "C" && environment.LC_ALL === "C" && environment.PATH === "/usr/bin:/bin";
  };

  net.Socket.prototype.connect = blockedNetwork;
  dgram.Socket.prototype.connect = blockedNetwork;
  dgram.Socket.prototype.send = blockedNetwork;
  globalThis.fetch = blockedNetwork;
  for (const name of [
    "exec",
    "execFile",
    "execFileSync",
    "execSync",
    "fork",
    "spawn",
  ]) {
    childProcess[name] = blockedChild;
  }
  childProcess.spawnSync = (file, arguments_, options) => {
    if (!isExactFfmpegDecode(file, arguments_, options)) return blockedChild();
    return originalSpawnSync(file, arguments_, options);
  };
}
