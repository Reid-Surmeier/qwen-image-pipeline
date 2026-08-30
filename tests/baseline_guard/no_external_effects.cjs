"use strict";

if (process.env.QWEN_BASELINE_OFFLINE === "1") {
  const net = require("node:net");
  const childProcess = require("node:child_process");

  const blockedNetwork = () => {
    throw new Error("network access is disabled in the deterministic baseline");
  };

  const blockedChild = () => {
    throw new Error("descendant process is disabled in the deterministic baseline");
  };

  net.Socket.prototype.connect = blockedNetwork;
  globalThis.fetch = blockedNetwork;
  for (const name of [
    "exec",
    "execFile",
    "execFileSync",
    "execSync",
    "fork",
    "spawn",
    "spawnSync",
  ]) {
    childProcess[name] = blockedChild;
  }
}
