import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEBUDDY_TOOL_LIMITS } from "../../src/adapters/codebuddy/tool-bridge";

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
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("CodeBuddy capture-only MCP server", () => {
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

      await expect(client.callTool({
        name: "not-advertised",
        arguments: {},
      })).rejects.toThrow("unknown isolated tool");

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
});
