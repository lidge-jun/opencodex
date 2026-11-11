import { describe, expect, spyOn, test } from "bun:test";
import { handleAliasCommand } from "../../src/cli/alias";

describe("alias list JSON flags", () => {
  test.each([["--json"], ["list", "--json"], ["--json", "list"]].map(args => [args]))("lists aliases for %j", async args => {
    const out = spyOn(console, "log").mockImplementation(() => {});
    const paths: string[] = [];
    const payload = { providers: { local: "Work" }, models: {} };
    try {
      expect(await handleAliasCommand(args, { baseUrl: "http://cli.test", fetchImpl: async input => {
        paths.push(String(input)); return Response.json(payload);
      } })).toBe(0);
      expect(paths).toEqual(["http://cli.test/api/aliases"]);
      expect(JSON.parse(String(out.mock.calls[0]![0]))).toEqual(payload);
    } finally { out.mockRestore(); }
  });
  test("a leading JSON flag does not turn mutation into a list", async () => {
    const out = spyOn(console, "log").mockImplementation(() => {});
    try {
      let method: string | undefined;
      expect(await handleAliasCommand(["--json", "set", "local", "Work"], {
        baseUrl: "http://cli.test", fetchImpl: async (_input, init) => { method = init?.method; return Response.json({ ok: true }); },
      })).toBe(0);
      expect(method).toBe("PUT");
    } finally { out.mockRestore(); }
  });
});


describe("alias failure boundaries", () => {
  test.each([
    { args: ["set"], message: "alias target is required" },
    { args: ["list", "--wat"], message: "Unexpected argument(s): --wat" },
    { args: ["wat"], message: "Unknown alias action: wat. See: ocx help alias" },
    { args: ["wat", "local"], message: "Unknown alias action: wat. See: ocx help alias" },
  ])("alias usage $args returns exit 2 before requests", async ({ args, message }) => {
    const out = spyOn(console, "log").mockImplementation(() => {});
    const err = spyOn(console, "error").mockImplementation(() => {});
    let requests = 0;
    try {
      expect(await handleAliasCommand(args, { baseUrl: "http://cli.test", fetchImpl: async () => {
        requests++; throw new Error("unexpected request");
      } })).toBe(2);
      expect(requests).toBe(0);
      expect(out.mock.calls).toEqual([]);
      expect(err.mock.calls.map(call => call.join(" ")).join("\n")).toContain(message);
    } finally { out.mockRestore(); err.mockRestore(); }
  });
  test.each([{ status: 404, code: 4 }, { status: 409, code: 5 }, { status: 500, code: 1 }])(
    "alias API status $status returns exit $code", async ({ status, code }) => {
      const err = spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(await handleAliasCommand(["list"], { baseUrl: "http://cli.test", fetchImpl: async () =>
          Response.json({ error: "fixture failure" }, { status }) })).toBe(code);
      } finally { err.mockRestore(); }
    },
  );
});

describe("#7705 alias template commands", () => {
  test("set, rm and show reach the template route and the list", async () => {
    const out = spyOn(console, "log").mockImplementation(() => {});
    const calls: Array<{ path: string; method: string; body: unknown }> = [];
    const deps = { baseUrl: "http://cli.test", fetchImpl: async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ path: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
      return Response.json({ ok: true, templates: { cc: "{providerAlias}-{modelBasename}" }, preview: { generated: 3, skipped: [] } });
    } };
    try {
      expect(await handleAliasCommand(["template", "set", "cc", "{providerAlias}-{modelBasename}"], deps)).toBe(0);
      expect(await handleAliasCommand(["template", "rm", "cc"], deps)).toBe(0);
      expect(await handleAliasCommand(["template", "show", "cc"], deps)).toBe(0);
      expect(calls).toEqual([
        { path: "http://cli.test/api/providers/cc/alias-template", method: "PUT", body: { template: "{providerAlias}-{modelBasename}" } },
        { path: "http://cli.test/api/providers/cc/alias-template", method: "PUT", body: { template: null } },
        { path: "http://cli.test/api/aliases", method: "GET", body: null },
      ]);
      expect(out.mock.calls.map(call => call.join(" ")).join("\n")).toContain("cc: {providerAlias}-{modelBasename}");
    } finally { out.mockRestore(); }
  });

  test("a template action without its operands is a usage error before any request", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    let requests = 0;
    try {
      for (const args of [["template"], ["template", "set", "cc"], ["template", "rm"], ["template", "wat", "cc"]]) {
        expect(await handleAliasCommand(args, { baseUrl: "http://cli.test", fetchImpl: async () => { requests++; return Response.json({}); } })).toBe(2);
      }
      expect(requests).toBe(0);
    } finally { err.mockRestore(); }
  });
});
