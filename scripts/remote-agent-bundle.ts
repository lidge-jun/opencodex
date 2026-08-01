import { lstatSync, readFileSync } from "node:fs";
import {
  REMOTE_AGENT_PUBLIC_KEY_PEM,
  REMOTE_AGENT_SPECS,
  assembleRemoteAgentBundle,
  verifyRemoteAgentBundle,
} from "../src/remote/agent-bundle";

function usage(): never {
  throw new Error("Usage: remote-agent-bundle.ts assemble <artifacts> <bundle> <release-assets> | verify <bundle>");
}

function readExpectedPublicKey(): string {
  const path = process.env.REMOTE_AGENT_EXPECTED_PUBLIC_KEY_FILE?.trim();
  if (!path) return REMOTE_AGENT_PUBLIC_KEY_PEM;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 16 * 1024) {
    throw new Error("Remote Agent expected public key must be a bounded regular file");
  }
  return readFileSync(path, "utf8");
}

function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
  if (typeof pkg.version !== "string" || pkg.version.length === 0) throw new Error("package.json version is unavailable");
  return pkg.version;
}

function readSigningKey(): string {
  const path = process.env.REMOTE_AGENT_SIGNING_KEY_FILE?.trim();
  if (!path) throw new Error("REMOTE_AGENT_SIGNING_KEY_FILE is required");
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error("Remote Agent signing key file is unavailable");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 64 * 1024) {
    throw new Error("Remote Agent signing key must be a bounded regular file");
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error("Remote Agent signing key permissions must be 0600 or stricter");
  }
  return readFileSync(path, "utf8");
}

const [command, ...args] = process.argv.slice(2);

if (command === "assemble") {
  if (args.length !== 3) usage();
  const sourceCommit = process.env.GITHUB_SHA?.trim().toLowerCase() ?? "";
  const manifest = assembleRemoteAgentBundle({
    inputRoot: args[0],
    bundleRoot: args[1],
    releaseAssetsRoot: args[2],
    privateKeyPem: readSigningKey(),
    sourceCommit,
    packageVersion: packageVersion(),
    expectedPublicKeyPem: readExpectedPublicKey(),
  });
  console.log(`Assembled and verified ${Object.keys(manifest.artifacts).length} signed Remote Agent artifacts.`);
} else if (command === "verify") {
  if (args.length !== 1) usage();
  verifyRemoteAgentBundle(args[0], readExpectedPublicKey(), packageVersion());
  console.log(`Verified ${REMOTE_AGENT_SPECS.length} signed Remote Agent artifacts.`);
} else {
  usage();
}
