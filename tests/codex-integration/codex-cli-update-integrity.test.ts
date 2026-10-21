import { describe, expect, test } from "bun:test";
import type { spawnSync } from "node:child_process";
import { resolveCodexCliUpdateTarget } from "../../src/codex/cli-update-plan";

const integrity = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;

function resolveWith(token: string) {
  let queries = 0;
  const outputs = ["1.4.2", token, "https://registry.npmjs.org/@openai/codex/-/codex-1.4.2.tgz"];
  const spawn = (() => ({ status: 0, stdout: outputs[queries++], stderr: "" })) as typeof spawnSync;
  return { target: resolveCodexCliUpdateTarget("latest", spawn), queries };
}

describe("Codex CLI registry SHA-512 evidence", () => {
  test("accepts a complete canonical SHA-512 digest in a multi-hash response", () => {
    expect(resolveWith(`'sha1-old ${integrity}'\n`)).toEqual({
      target: { kind: "resolved", version: "1.4.2", integrity }, queries: 3,
    });
  });

  test.each([
    "sha512-AAAA",
    "sha512-====",
    `sha512-${Buffer.alloc(63).toString("base64")}`,
    `sha512-${Buffer.alloc(65).toString("base64")}`,
    // Node's permissive base64 decoder accepts nonzero unused padding bits.
    `sha512-${"A".repeat(85)}B==`,
    integrity.replace("==", ""),
  ])("refuses malformed integrity %s before querying the tarball", token => {
    const result = resolveWith(token);
    expect(result.target.kind).toBe("unresolved");
    expect(result.queries).toBe(2);
  });
});
