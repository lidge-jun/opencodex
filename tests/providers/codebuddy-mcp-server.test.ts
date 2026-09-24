import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { CODEBUDDY_TOOL_LIMITS } from "../../src/adapters/codebuddy/tool-bridge";
import { codeBuddyMcpInvocation } from "../../src/adapters/coding-agent/turn";

const tempDirs: string[] = [];
const serverPath = join(
  import.meta.dir,
  "..",
  "..",
  "src",
  "adapters",
  "codebuddy",
  "mcp-server.ts",
);

function definition(
  name: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name,
    description: `Description for ${name}`,
    inputSchema: { type: "object" },
    ...overrides,
  };
}

async function rejectedCatalog(rawCatalog: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "opencodex-codebuddy-mcp-reject-"));
  tempDirs.push(dir);
  const catalogPath = join(dir, "tools.json");
  writeFileSync(catalogPath, rawCatalog, { mode: 0o600 });
  const child = Bun.spawn({
    cmd: [process.execPath, serverPath, catalogPath],
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderrPromise = new Response(child.stderr).text();
  const exitCode = await child.exited;
  const stderr = await stderrPromise;
  expect(exitCode).not.toBe(0);
  return stderr;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    // Windows keeps the compiled ocx executable locked for a moment after its process exits, so
    // a plain rmSync fails with EBUSY; the shared helper waits on the same bounded schedule as
    // every other fixture teardown.
    removeTreeWithRetry(dir);
  }
});

describe("CodeBuddy capture-only MCP server", () => {
  test("compiled ocx exposes the same capture-only catalog", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-compiled-codebuddy-mcp-"));
    tempDirs.push(dir);
    const binary = join(dir, "ocx");
    const compiled = Bun.spawnSync([process.execPath, "build", "--compile", join(import.meta.dir, "../../src/cli/index.ts"), "--outfile", binary]);
    expect(compiled.exitCode).toBe(0);
    if (process.platform === "darwin") {
      const signed = Bun.spawnSync(["codesign", "--force", "--sign", "-", binary]);
      expect(signed.exitCode).toBe(0);
    }
    const version = Bun.spawnSync([binary, "--version"]);
    expect(version.exitCode).toBe(0);
    expect(version.stderr.toString()).toBe("");
    expect(version.stdout.toString()).toContain("opencodex");
    const catalogPath = join(dir, "catalog.json");
    writeFileSync(catalogPath, JSON.stringify([definition("lookup")]), { mode: 0o600 });
    const probe = Bun.spawn({ cmd: [binary, ...codeBuddyMcpInvocation(serverPath, catalogPath, true)], stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    probe.stdin.end();
    const probeError = await new Response(probe.stderr).text();
    const probeOutput = await new Response(probe.stdout).text();
    expect({ exit: await probe.exited, stderr: probeError, stdout: probeOutput }).toEqual({ exit: 0, stderr: "", stdout: "" });
    const transport = new StdioClientTransport({
      command: binary,
      args: codeBuddyMcpInvocation(serverPath, catalogPath, true),
      stderr: "pipe",
    });
    const client = new Client({ name: "compiled-codebuddy-test", version: "1.0.0" });
    let bridgeStderr = "";
    transport.stderr?.on("data", chunk => { bridgeStderr += String(chunk); });
    try {
      await client.connect(transport).catch(error => { throw new Error(`compiled bridge failed: ${String(error)}; stderr: ${bridgeStderr}`); });
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(["lookup"]);
    } finally {
      await client.close();
    }
  });

  test("advertises only the private catalog, rejects unknown tools, and never executes known tools", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opencodex-codebuddy-mcp-test-"));
    tempDirs.push(dir);
    const catalogPath = join(dir, "tools.json");
    writeFileSync(catalogPath, JSON.stringify([{
      name: "lookup",
      description: "Look up an item.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "number" } },
        required: ["id"],
      },
    }]), { mode: 0o600 });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverPath, catalogPath],
      stderr: "pipe",
    });
    const client = new Client({ name: "codebuddy-capture-test", version: "1.0.0" });

    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools).toEqual([{
        name: "lookup",
        description: "Look up an item.",
        inputSchema: {
          type: "object",
          properties: { id: { type: "number" } },
          required: ["id"],
        },
      }]);

      // Settle the real stdio exchange before asserting: Bun 1.4.0's rejection
      // matcher stalls this SDK response when it waits on the pending call itself.
      const unknownError = await client.callTool({
        name: "not-advertised",
        arguments: {},
      }).catch((error: unknown) => error);
      expect(unknownError).toBeInstanceOf(Error);
      expect((unknownError as Error).message).toContain("unknown isolated tool");

      const abort = new AbortController();
      let settled = false;
      const pending = client.callTool({
        name: "lookup",
        arguments: { id: 7 },
      }, undefined, { signal: abort.signal });
      void pending.finally(() => { settled = true; }).catch(() => {});
      await Bun.sleep(50);
      expect(settled).toBe(false);
      abort.abort();
      await expect(pending).rejects.toThrow();
    } finally {
      await client.close();
    }
  });

  test("reads at most the catalog limit plus one byte", async () => {
    const stderr = await rejectedCatalog(
      " ".repeat(CODEBUDDY_TOOL_LIMITS.maxCatalogBytes + 1),
    );
    expect(stderr).toContain("tool catalog is too large");
  });

  test("revalidates count, unique names, text, and schema boundaries in the helper", async () => {
    let deeplyNested: Record<string, unknown> = { type: "object" };
    for (let depth = 0; depth <= CODEBUDDY_TOOL_LIMITS.maxSchemaDepth; depth++) {
      deeplyNested = { type: "object", nested: deeplyNested };
    }

    const cases: Array<{ expected: string; value: unknown }> = [
      {
        expected: "too many definitions",
        value: Array.from(
          { length: CODEBUDDY_TOOL_LIMITS.maxTools + 1 },
          (_, index) => definition(`tool_${index}`),
        ),
      },
      {
        expected: "duplicate names",
        value: [definition("same"), definition("same")],
      },
      {
        expected: "invalid definition",
        value: [definition("invalid name")],
      },
      {
        expected: "invalid definition",
        value: [definition("description", {
          description: "d".repeat(CODEBUDDY_TOOL_LIMITS.maxDescriptionBytes + 1),
        })],
      },
      {
        expected: "object type",
        value: [definition("wrong_root", { inputSchema: { type: "array" } })],
      },
      {
        expected: "too deeply nested",
        value: [definition("deep", { inputSchema: deeplyNested })],
      },
    ];

    for (const { expected, value } of cases) {
      const stderr = await rejectedCatalog(JSON.stringify(value));
      expect(stderr).toContain(expected);
    }
  });

  test("exits when stdin closes instead of outliving the CLI", async () => {
    // The pinned MCP SDK (1.30.0) does not detect stdin EOF itself. Without the explicit
    // end/close handlers, this capture server would linger as an orphaned bun process
    // whenever the parent terminates the CLI it serves.
    const dir = mkdtempSync(join(tmpdir(), "opencodex-codebuddy-mcp-eof-"));
    tempDirs.push(dir);
    const catalogPath = join(dir, "tools.json");
    writeFileSync(catalogPath, JSON.stringify([definition("lookup")]), { mode: 0o600 });
    const child = Bun.spawn({
      cmd: [process.execPath, serverPath, catalogPath],
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    });
    child.stdin.end();
    const exit = await Promise.race([
      child.exited,
      Bun.sleep(4_000).then(() => "timeout" as const),
    ]);
    if (exit === "timeout") child.kill();
    expect(exit).toBe(0);
  });
});
