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
