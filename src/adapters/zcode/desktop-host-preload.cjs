// ZCode has no public CLI flag for selecting its user config. Keep the official
// runtime's state/config in OpenCodex's private home while leaving process.env.HOME
// untouched for the native tools that the official runtime starts.
const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const os = require("node:os");
const path = require("node:path");

const key = "OCX_ZCODE_RUNTIME_HOME";
const requested = process.env[key];
delete process.env[key];

// A process spawned by ZCode may inherit execArgv in unusual launchers. The
// one-shot environment marker makes this preload a no-op outside the owned root.
if (requested !== undefined) {
  if (!path.isAbsolute(requested) || requested.includes("\0")) {
    throw new Error("ZCode private runtime home is invalid.");
  }
  const resolved = fs.realpathSync(requested);
  const metadata = fs.lstatSync(resolved);
  if (!metadata.isDirectory() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0) {
    throw new Error("ZCode private runtime home is invalid.");
  }
  Object.defineProperty(os, "homedir", { configurable: true, enumerable: true,
    value: () => resolved, writable: true });
  syncBuiltinESMExports();
}
