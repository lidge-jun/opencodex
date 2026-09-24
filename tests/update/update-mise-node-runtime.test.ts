import { describe, expect, test } from "bun:test";
import { detectInstallOwnershipFromPath } from "../../src/update/install-detection.mjs";

// npm -g under a mise-managed Node on Windows installs straight into the runtime's
// <version>/node_modules, where the adjacent .mise.backend.toml is Node's own record.
// That install is npm-owned; it must not be refused as contradictory mise metadata.
const NODE_RUNTIME = 'short = "node"\nfull = "core:node"\n';

function detect(path: string, metadataPath: string, content: string) {
  return detectInstallOwnershipFromPath(path, {
    exists: () => false,
    probe: (value: string) => (value === metadataPath ? "present" : "absent"),
    readFile: () => content,
    realpath: (value: string) => value,
  });
}

describe("npm global under a mise-managed Node runtime", () => {
  test("Windows npm -g under mise core Node is an npm install", () => {
    const root = "C:/Users/example/AppData/Local/mise/installs/node";
    const metadata = root + "/.mise.backend.toml";
    for (const path of [
      "C:\\Users\\example\\AppData\\Local\\mise\\installs\\node\\22.12.0\\node_modules\\@bitkyc08\\opencodex\\bin",
      root + "/22.12.0/node_modules/@bitkyc08/opencodex/bin",
      root + "/22.12.0/node_modules/@bitkyc08/opencodex",
    ]) {
      expect(detect(path, metadata, NODE_RUNTIME)).toEqual({ installer: "npm" });
    }
  });

  test("a POSIX runtime layout never reaches the Node record", () => {
    const root = "/home/example/.local/share/mise/installs/node";
    expect(detect(root + "/22.12.0/lib/node_modules/@bitkyc08/opencodex/bin", root + "/.mise.backend.toml", NODE_RUNTIME))
      .toEqual({ installer: "npm" });
  });

  test("any other runtime record under a node tool root stays fail-closed", () => {
    const root = "C:/mise/installs/node";
    const path = root + "/22.12.0/node_modules/@bitkyc08/opencodex/bin";
    for (const content of [
      'short = "node"\nfull = "asdf:someone/node"\n',
      'short = "nodejs"\nfull = "core:node"\n',
    ]) {
      expect(detect(path, root + "/.mise.backend.toml", content))
        .toMatchObject({ installer: "mise", owner: null, error: "metadata_inconsistent" });
    }
  });

  test("the Node record does not cover a package nested deeper than the runtime's global node_modules", () => {
    const root = "C:/mise/installs/node";
    const path = root + "/22.12.0/node_modules/some-tool/node_modules/@bitkyc08/opencodex/bin";
    expect(detect(path, root + "/.mise.backend.toml", NODE_RUNTIME))
      .toMatchObject({ installer: "mise", owner: null, error: "metadata_inconsistent" });
  });

  test("an OpenCodex record aliased as node is still mise-owned", () => {
    const root = "C:/mise/installs/node";
    const path = root + "/2.65.0/node_modules/@bitkyc08/opencodex/bin";
    expect(detect(path, root + "/.mise.backend.toml", 'short = "node"\nfull = "npm:@bitkyc08/opencodex"\n'))
      .toMatchObject({ installer: "mise", owner: { tool: "node", backend: "npm:@bitkyc08/opencodex" } });
  });
});

