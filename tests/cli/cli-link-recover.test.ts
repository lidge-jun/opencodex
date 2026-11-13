import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { runLinkCommand, type LinkCliDeps } from "../../src/cli/link";
import { createTempHome, type TempHome } from "../helpers/temp-home";

// ocx link recover (lane O5): the CLI half of POST /api/link/recover.

const ID = "lnk_0123456789abcdef";
let home: TempHome;
let output: ReturnType<typeof spyOn>, errors: ReturnType<typeof spyOn>, network: ReturnType<typeof spyOn>;
let oldToken: string | undefined;
beforeEach(() => {
  home = createTempHome("ocx-cli-link-recover-");
  oldToken = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  output = spyOn(console, "log").mockImplementation(() => {});
  errors = spyOn(console, "error").mockImplementation(() => {});
  network = spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Network forbidden"); });
});
afterEach(() => {
  expect(network).not.toHaveBeenCalled();
  network.mockRestore(); output.mockRestore(); errors.mockRestore();
  if (oldToken === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = oldToken;
  home.remove();
});

function fixture(body: unknown = { linkId: ID, outcome: "clean", purged: true }, status = 200) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const deps: LinkCliDeps = {
    findLiveProxy: async () => ({ pid: null, port: 15100, source: "runtime" }),
    readAdminToken: () => "fixture-admin-token",
    fetchImpl: async (input, init) => { calls.push({ url: String(input), init }); return Response.json(body, { status }); },
  };
  return { calls, deps };
}

describe("ocx link recover", () => {
  test.each([[[]], [["--link-id", ID, "--operation-id", "attach-1"]], [["--link-id", "lnk_nothex"]], [["--operation-id", ""]], [["--link-id", ID, "--force"]]])(
    "usage %j is refused before any request", async args => {
      const f = fixture();
      expect(await runLinkCommand(["recover", ...args], f.deps)).toBe(2);
      expect(f.calls).toEqual([]);
    },
  );

  test("--link-id posts the link id and prints the clean receipt", async () => {
    const f = fixture();
    expect(await runLinkCommand(["recover", "--link-id", ID, "--json"], f.deps)).toBe(0);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url).toBe("http://127.0.0.1:15100/api/link/recover");
    expect(f.calls[0]?.init?.method).toBe("POST");
    expect(f.calls[0]?.init?.redirect).toBe("error");
    expect(JSON.parse(String(f.calls[0]?.init?.body))).toEqual({ linkId: ID });
    expect(JSON.parse(output.mock.calls.flat().join("\n"))).toEqual({ linkId: ID, outcome: "clean", purged: true });
  });

  test("--operation-id posts the operation id; human output says the Child is clean", async () => {
    const f = fixture();
    expect(await runLinkCommand(["recover", "--operation-id", "attach-1"], f.deps)).toBe(0);
    expect(JSON.parse(String(f.calls[0]?.init?.body))).toEqual({ operationId: "attach-1" });
    expect(output.mock.calls.flat().join("\n")).toContain("Recovered " + ID);
  });

  test.each([
    [409, "child_residual", 5],
    [409, "child_conflict", 5],
    [404, "tombstone_not_found", 4],
    [502, "remote_recover_failed", 1],
  ])("HTTP %d %s exits %d without printing a receipt", async (status, code, exit) => {
    const f = fixture({ error: { code, message: "fixed message" } }, status);
    expect(await runLinkCommand(["recover", "--link-id", ID], f.deps)).toBe(exit);
    expect(output).not.toHaveBeenCalled();
  });

  test.each([{}, { linkId: "lnk_fedcba9876543210", outcome: "clean", purged: true }, { linkId: ID, outcome: "clean", purged: false }, { linkId: ID, outcome: "clean", purged: true, extra: 1 }])(
    "a receipt %j that does not prove cleanup fails", async body => {
      const f = fixture(body);
      expect(await runLinkCommand(["recover", "--link-id", ID, "--json"], f.deps)).toBe(1);
      expect(output).not.toHaveBeenCalled();
    },
  );
});

describe("ocx link recover contract", () => {
  test("ocx capabilities --contracts --json advertises link.recover/1 beside the recover verb", async () => {
    const { runCapabilities } = await import("../../src/cli/capabilities-command");
    expect(await runCapabilities(["--contracts", "--json"])).toBe(0);
    expect(JSON.parse(String(output.mock.calls.at(-1)![0])).contracts).toContain("link.recover/1");
    output.mockClear();
    expect(await runCapabilities(["--json"])).toBe(0);
    const document = JSON.parse(String(output.mock.calls.at(-1)![0])) as { capabilities: Array<{ command: string[]; routes: Array<{ method: string; path: string }> }> };
    const recover = document.capabilities.find(entry => entry.command.join(" ") === "link recover");
    expect(recover?.routes).toEqual([{ method: "POST", path: "/api/link/recover" }]);
  });
});
