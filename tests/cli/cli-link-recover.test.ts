import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { runLinkCommand, type LinkCliDeps } from "../../src/cli/link";
import type { LinkStore } from "../../src/link/store";
import { readTombstones, recordTombstone } from "../../src/link/tombstones";
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

  test.each([{}, { linkId: "lnk_fedcba9876543210", outcome: "clean", purged: true }, { linkId: ID, outcome: "clean", purged: "no" }, { linkId: ID, outcome: "clean", purged: true, extra: 1 }])(
    "a receipt %j that does not prove cleanup fails", async body => {
      const f = fixture(body);
      expect(await runLinkCommand(["recover", "--link-id", ID, "--json"], f.deps)).toBe(1);
      expect(output).not.toHaveBeenCalled();
    },
  );

  // A refusal names its code (and a closed-form hint) so alias_linked is never mistaken for child_residual, whose remedy
  // (ocx-child detach on the machine) would there detach the other link. The server's message is never printed.
  const stderr = () => errors.mock.calls.flat().map(String).join("\n");

  test("alias_linked says another Home-initiated link holds the alias and what to do, in text and --json", async () => {
    for (const json of [false, true]) {
      errors.mockClear();
      const f = fixture({ error: { code: "alias_linked", message: "server text" } }, 409);
      expect(await runLinkCommand(["recover", "--link-id", ID, ...(json ? ["--json"] : [])], f.deps)).toBe(5);
      expect(stderr()).toContain("alias_linked");
      expect(stderr()).toContain("another Home-initiated link");
      expect(stderr()).toContain("ocx link revoke");
      // The other link may be the live one, and no status check can show it is stale: an attach of it in progress can show no
      // link or an earlier one (ocx-child's status reads only state.json), and unreadable state shows none (#8691 review).
      expect(stderr()).toContain("Leave that link: no status check on the machine can show it is stale");
      expect(stderr()).toContain("do that only if you mean to end that link");
      // Recover is never run for the operator; the revoke names the other link's id (#8691 final review).
      expect(stderr()).toContain("then run ocx link recover --link-id " + ID + " again");
      expect(stderr()).toContain("ocx link revoke --link-id <that link's id>, shown by ocx link status");
      expect(stderr()).not.toContain("recover runs then");
      expect(stderr()).not.toContain("Only if it shows");
      expect(stderr()).not.toContain("Check which link it runs");
      // The forget way out is its own sentence (not under the branch that keeps the machine running), with this link's id.
      expect(stderr()).toContain("A person on this Home can instead forget this tombstone (ocx link recover --forget --link-id " + ID + " --yes) once the machine is confirmed clean or gone.");
      expect(stderr()).not.toContain("--link-id <id>");
      expect(stderr()).not.toContain("Do not run ocx-child detach on the machine: settle");
      expect(stderr()).not.toContain("server text");
    }
  });

  // The CLI prints its own text, never the server's, so child_recover_unsupported needs one: no plain detach (its status cannot
  // show an interrupted attach of another link), and the forget way out with this link's id (#8691 review).
  test("child_recover_unsupported says to leave the machine and how a person forgets, in text and --json", async () => {
    for (const json of [false, true]) {
      errors.mockClear();
      const f = fixture({ error: { code: "child_recover_unsupported", message: "server text" } }, 409);
      expect(await runLinkCommand(["recover", "--link-id", ID, ...(json ? ["--json"] : [])], f.deps)).toBe(5);
      expect(stderr()).toContain("child_recover_unsupported: the planted ocx-child predates detach --expect-link");
      expect(stderr()).toContain("Do not run its plain detach on the machine");
      expect(stderr()).toContain("ocx link recover --forget --link-id " + ID + " --yes");
      // No path to "clean" exists through recover with this build: gone, or cleaned by hand on the machine (#8691 final review).
      expect(stderr()).toContain("Once the machine is gone, or a person on that machine has checked and cleaned its ocx-child records by hand");
      expect(stderr()).not.toContain("confirmed clean or gone");
      expect(stderr()).not.toContain("server text");
    }
  });

  // An --operation-id recover's target comes from the journal, not a tombstone (--list shows only tombstones), so its steps
  // name the operation id the CLI validated (#8694 final review).
  test.each([
    ["child_recover_unsupported", "a person on this Home can run ocx link operations resolve --operation-id enroll-7 --yes"],
    ["alias_linked", "then run ocx link recover --operation-id enroll-7 again"],
    ["alias_linked", "resolve the operation (ocx link operations resolve --operation-id enroll-7 --yes)"],
  ])("a %s refusal for an --operation-id recover names the operation id", async (code, expected) => {
    errors.mockClear();
    const f = fixture({ error: { code, message: "server text" } }, 409);
    expect(await runLinkCommand(["recover", "--operation-id", "enroll-7"], f.deps)).toBe(5);
    expect(stderr()).toContain(expected);
    expect(stderr()).not.toContain("--link-id <the link's id");
    expect(stderr()).not.toContain("ocx link recover --list>");
    expect(stderr()).not.toContain("This tombstone");
    expect(stderr()).not.toContain("server text");
  });

  // A full install refuses --purge (purge_unsupported), so link_present names --purge only for a lightweight Child.
  test("link_present says to revoke the link, with --purge only for a lightweight Child", async () => {
    const f = fixture({ error: { code: "link_present", message: "server text" } }, 409);
    expect(await runLinkCommand(["recover", "--link-id", ID], f.deps)).toBe(5);
    expect(stderr()).toContain("revoke it (ocx link revoke, with --purge for a lightweight Child)");
    expect(stderr()).not.toContain("server text");
  });


  test("a code that names an Object prototype key prints only the code", async () => {
    const f = fixture({ error: { code: "constructor", message: "server text" } }, 409);
    await runLinkCommand(["recover", "--link-id", ID], f.deps);
    expect(stderr()).toContain("constructor");
    expect(stderr()).not.toContain("native code");
  });

  test.each([
    [409, "child_residual", "codex-home-owner", "child_residual (codex-home-owner)"],
    [502, "remote_recover_failed", "ssh_failed", "remote_recover_failed (ssh_failed)"],
    [502, "remote_recover_failed", "/home/someone/.cache path", "remote_recover_failed"],
  ])("HTTP %d %s names the code and only a closed-form hint", async (status, code, hint, shown) => {
    const f = fixture({ error: { code, hint, message: "server text" } }, status);
    await runLinkCommand(["recover", "--link-id", ID], f.deps);
    expect(stderr()).toContain(shown);
    expect(stderr()).not.toContain("server text");
    expect(stderr()).not.toContain("/home/someone");
  });
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
    expect(recover?.routes).toEqual([{ method: "POST", path: "/api/link/recover" }, { method: "GET", path: "/api/link/recover" }]);
  });

  test("--list prints what waits, and validates the answer", async () => {
    const waiting = { tombstones: [{ linkId: ID, alias: "devbox", revokedAt: "2026-11-01T00:00:00.000Z" }] };
    const f = fixture(waiting);
    expect(await runLinkCommand(["recover", "--list", "--json"], f.deps)).toBe(0);
    expect(f.calls[0]?.init?.method).toBe("GET");
    expect(JSON.parse(output.mock.calls.flat().join("\n"))).toEqual(waiting);
    expect(await runLinkCommand(["recover", "--list"], fixture({ tombstones: [{ linkId: "nope" }] }).deps)).not.toBe(0);
    expect(await runLinkCommand(["recover", "--list", "--link-id", ID], fixture(waiting).deps)).toBe(2);
  });

  test("--forget is for a person on the Home: it needs --yes, refuses an agent or a runner, and never calls the API", async () => {
    recordTombstone({ linkId: ID, alias: "gone-vm", hostKeyFingerprint: "SHA256:" + "A".repeat(43), revokedAt: "2026-11-01T00:00:00.000Z" });
    const noLinks = (): LinkStore => ({ version: 1, listenerPort: 18181, links: [] });
    const noYes = fixture();
    expect(await runLinkCommand(["recover", "--forget", "--link-id", ID], { ...noYes.deps, readStore: noLinks, agentDriven: () => false })).toBe(2);
    const agent = fixture();
    expect(await runLinkCommand(["recover", "--forget", "--link-id", ID, "--yes"], { ...agent.deps, readStore: noLinks, agentDriven: () => true })).toBe(2);
    expect(readTombstones().tombstones.map(t => t.linkId)).toEqual([ID]);
    // While the link exists (a forced revoke not yet committed), forget refuses.
    const present = fixture();
    const withLink = (): LinkStore => ({ version: 1, listenerPort: 18181, links: [{ id: ID, alias: "gone-vm", direction: "hub-initiated", hostKeyFingerprint: "SHA256:x", tunnelPort: 24500, apiKeyId: "k", createdAt: "2026-11-01T00:00:00.000Z" }] as LinkStore["links"] });
    expect(await runLinkCommand(["recover", "--forget", "--link-id", ID, "--yes"], { ...present.deps, readStore: withLink, agentDriven: () => false })).not.toBe(0);
    expect(readTombstones().tombstones.map(t => t.linkId)).toEqual([ID]);
    const person = fixture();
    expect(await runLinkCommand(["recover", "--forget", "--link-id", ID, "--yes", "--json"], { ...person.deps, readStore: noLinks, agentDriven: () => false })).toBe(0);
    expect(readTombstones().tombstones).toEqual([]);
    expect(JSON.parse(output.mock.calls.flat().join("\n"))).toEqual({ linkId: ID, outcome: "forgotten" });
    expect([noYes.calls, agent.calls, present.calls, person.calls]).toEqual([[], [], [], []]);
    expect(await runLinkCommand(["recover", "--forget", "--link-id", ID, "--yes"], { ...fixture().deps, readStore: noLinks, agentDriven: () => false })).not.toBe(0);
    expect(await runLinkCommand(["recover", "--link-id", ID, "--yes"], fixture().deps)).toBe(2);
  });

  test("a receipt whose binary stayed for another home's relay is a recovery, and says why", async () => {
    const f = fixture({ linkId: ID, outcome: "clean", purged: false });
    expect(await runLinkCommand(["recover", "--link-id", ID], f.deps)).toBe(0);
    expect(output.mock.calls.flat().join("\n")).toContain("another OpenCodex home on that machine runs a relay from it");
  });
});
