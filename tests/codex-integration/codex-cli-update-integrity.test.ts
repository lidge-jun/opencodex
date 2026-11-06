import { describe, expect, test } from "bun:test";
import type { spawnSync } from "node:child_process";
import { resolveCodexCliUpdateArtifactTarget } from "../../src/codex/cli-update-plan";

const integrity = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;

async function resolveWith(token: string) {
  let queries = 0;
  const spawn = ((_bin: string, args: string[]) => {
    queries++;
    return { status: 0, stderr: "", stdout: JSON.stringify({
      name: args.join(" ").includes("@openai/codex-linux-x64@") ? "@openai/codex-linux-x64" : "@openai/codex",
      version: "1.4.2", optionalDependencies: { "@openai/codex-linux-x64": "1.4.2" },
      dist: { integrity: token, tarball: "https://registry.npmjs.org/@openai/codex/-/codex-1.4.2.tgz" },
    }) };
  }) as typeof spawnSync;
  return { target: await resolveCodexCliUpdateArtifactTarget("latest", spawn, undefined, "linux", "x64"), queries };
}

describe("Codex CLI registry SHA-512 evidence", () => {
  test("accepts a complete canonical SHA-512 digest for both production artifacts", async () => {
    const value = await resolveWith(integrity);
    expect(value.target).toMatchObject({ kind: "resolved", version: "1.4.2", integrity,
      artifacts: { backing: { name: "@openai/codex-linux-x64", integrity } } });
    expect(value.queries).toBe(3);
  });

  test.each([
    "sha512-AAAA",
    "sha512-====",
    `sha512-${Buffer.alloc(63).toString("base64")}`,
    `sha512-${Buffer.alloc(65).toString("base64")}`,
    // Node's permissive base64 decoder accepts nonzero unused padding bits.
    `sha512-${"A".repeat(85)}B==`,
    integrity.replace("==", ""),
    `sha1-old ${integrity}`,
  ])("refuses malformed integrity %s before querying the tarball", async token => {
    const result = await resolveWith(token);
    expect(result.target.kind).toBe("unresolved");
    expect(result.queries).toBe(2);
  });
});
