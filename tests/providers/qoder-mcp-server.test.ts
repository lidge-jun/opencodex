import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const serverPath = join(import.meta.dir, "../../src/adapters/coding-agent/mcp-server.ts");

describe("Qoder isolated MCP catalog", () => {
  test("lists the selected client tool name and unchanged schema", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-qoder-tools-"));
    const schema = { type: "object", properties: { value: { type: "string" } }, required: ["value"] };
    const catalogPath = join(dir, "catalog.json");
    writeFileSync(catalogPath, JSON.stringify([{ name: "probe_echo", description: "Return a marker", inputSchema: schema }]));
    const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath, catalogPath] });
    const client = new Client({ name: "qoder-catalog-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools).toEqual([
        { name: "probe_echo", description: "Return a marker", inputSchema: schema },
      ]);
    } finally {
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
