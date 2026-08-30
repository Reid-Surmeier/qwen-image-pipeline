"use strict";

if (process.env.QWEN_BASELINE_OFFLINE === "1") {
  const net = require("node:net");

  const blocked = () => {
    throw new Error("network access is disabled in the deterministic baseline");
  };

  net.Socket.prototype.connect = blocked;
  globalThis.fetch = blocked;
}
