import { describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { runLinkCommand, type LinkCliDeps } from "../../src/cli/link";
import { RuntimeApiError } from "../../src/cli/runtime-api";

/** O1: ocx link add|revoke --operation-id, ocx link add --require-ephemeral and ocx link operations. */
const fingerprint = "SHA256:abcdefghijklmnop";
const ALIAS = "pen-7f3a9c";
const OP = "attach-0001";
const LINK = "lnk_0123456789abcdef";
const probe = { alias: ALIAS, fingerprint, keyType: "ED25519", ocxVersion: "2.99.0" };
const confirm = { alias: ALIAS, fingerprint, ocxVersion: "2.99.0" };
const committed = { linkId: LINK, operationId: OP, outcome: "committed" };
const notFound = { status: 404, body: { error: { code: "operation_not_found", message: "No operation has this id." } } };

type Answer = { status?: number; body: unknown };
function harness(answers: Answer[]) {
  const calls: { method: string; path: string; body: unknown }[] = [], out: string[] = [], err: string[] = [];
  const log = console.log, error = console.error;
  console.log = (...args) => out.push(args.map(String).join(" "));
  console.error = (...args) => err.push(args.map(String).join(" "));
  const deps: LinkCliDeps = { baseUrl: "http://127.0.0.1:10100", readAdminToken: () => "ocx_admin_test",
    stdinImpl: Object.assign(Readable.from([]), { isTTY: false }),
    fetchImpl: async (url, init) => {
      calls.push({ method: init?.method ?? "GET", path: new URL(String(url)).pathname, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
      const next = answers.shift()!;
      return Response.json(next.body, { status: next.status ?? 200 });
    } };
  return { calls, out, err, deps, restore: () => { console.log = log; console.error = error; } };
}

test("a first add with an operation id looks the operation up, then probes, confirms and applies with it", async () => {
  const h = harness([notFound, { body: probe }, { body: confirm }, { status: 202, body: committed }]); try {
    expect(await runLinkCommand(["add", ALIAS, "--expect-fingerprint", fingerprint, "--operation-id", OP, "--require-ephemeral", "--json"], h.deps)).toBe(0);
    expect(h.calls.map(call => call.method + " " + call.path)).toEqual(["GET /api/link/operations/" + OP, "POST /api/link/probe", "POST /api/link/confirm-host", "POST /api/link/apply"]);
    expect(h.calls[1]!.body).toEqual({ alias: ALIAS, includeVersion: true, allowMissing: true });
    expect(h.calls[3]!.body).toEqual({ alias: ALIAS, fingerprint, operationId: OP, requireEphemeral: true });
    expect(JSON.parse(h.out[0]!)).toEqual({ linkId: LINK, alias: ALIAS, state: "connected", childRole: "client", operationId: OP, outcome: "committed" });
  } finally { h.restore(); }
});

test("a repeat of a recorded operation goes straight to apply, without a new probe", async () => {
  const h = harness([{ body: { operationId: OP, state: "committed" } }, { status: 202, body: committed }]); try {
    expect(await runLinkCommand(["add", ALIAS, "--expect-fingerprint", fingerprint, "--operation-id", OP, "--json"], h.deps)).toBe(0);
    expect(h.calls.map(call => call.method + " " + call.path)).toEqual(["GET /api/link/operations/" + OP, "POST /api/link/apply"]);
    expect(h.calls[1]!.body).toEqual({ alias: ALIAS, fingerprint, operationId: OP });
    expect(JSON.parse(h.out[0]!)).toMatchObject({ linkId: LINK, operationId: OP, outcome: "committed" });
  } finally { h.restore(); }
});

test("a recorded failure keeps its outcome in the error", async () => {
  const h = harness([{ body: { operationId: OP, state: "residual" } }, { status: 502, body: { error: { code: "child_restart_failed", message: "server text" }, operationId: OP, outcome: "residual", residual: true } }]); try {
    expect(await runLinkCommand(["add", ALIAS, "--expect-fingerprint", fingerprint, "--operation-id", OP], h.deps)).toBe(1);
    const message = h.err.join("\n");
    expect(message).toContain("operation " + OP + ": residual");
    expect(message).toContain("child_restart_failed");
    expect(message).not.toContain("server text");
  } finally { h.restore(); }
});

test("a replayed residual plant gets the CLI's own purge guidance for both platforms, never the disconnect step", async () => {
  const h = harness([{ body: { operationId: OP, state: "unknown" } }, { status: 500, body: { error: { code: "key_issue_uncertain", message: "server text" }, operationId: OP, outcome: "unknown", residual: true, residualKind: "plant", recovery: "server recovery text" } }]); try {
    expect(await runLinkCommand(["add", ALIAS, "--expect-fingerprint", fingerprint, "--operation-id", OP], h.deps)).toBe(1);
    const message = h.err.join("\n");
    expect(message).toContain("~/.cache/opencodex/bin/ocx-child detach --purge");
    expect(message).toContain('ocx-child.exe" detach --purge');
    // %VAR% and a bare quoted path are Command Prompt syntax; PowerShell would need & and $env:.
    expect(message).toContain("in Command Prompt");
    expect(message).not.toContain("ocx disconnect");
    expect(message).not.toContain("server recovery text");
    expect(message).toContain("operation " + OP + ": unknown");
  } finally { h.restore(); }
});

test.each(["child_port_busy", "child_external_provider_conflict"])("a %s answer whose plant rollback failed gives purge guidance, not 'no Child files were modified'", async errorCode => {
  const h = harness([notFound, { body: probe }, { body: confirm }, { status: 409, body: { error: { code: errorCode, message: "server text" }, operationId: OP, outcome: "residual", residual: true, residualKind: "plant" } }]); try {
    expect(await runLinkCommand(["add", ALIAS, "--expect-fingerprint", fingerprint, "--operation-id", OP], h.deps)).toBe(1);
    const message = h.err.join("\n");
    expect(message).toContain("ocx-child detach --purge");
    expect(message).toContain("%USERPROFILE%");
    expect(message).not.toContain("no Child files were modified");
    expect(message).toContain("operation " + OP + ": residual");
  } finally { h.restore(); }
});

test.each([
  ["--operation-id without --expect-fingerprint", ["add", ALIAS, "--operation-id", OP]],
  ["an invalid operation id", ["add", ALIAS, "--expect-fingerprint", fingerprint, "--operation-id", "-bad"]],
  ["--operation-id on probe", ["probe", ALIAS, "--operation-id", OP]],
  ["--require-ephemeral on probe", ["probe", ALIAS, "--require-ephemeral"]],
])("%s is a usage error before any request", async (_label, args) => {
  const h = harness([]); try {
    expect(await runLinkCommand(args, h.deps)).toBe(2);
    expect(h.calls).toEqual([]);
  } finally { h.restore(); }
});

test("a plain add refused by another operation on the alias names a link operation, not an enrollment or revoke", async () => {
  const h = harness([{ body: probe }, { body: confirm }, { status: 409, body: { error: { code: "link_operation_in_progress", message: "x" } } }]); try {
    expect(await runLinkCommand(["add", ALIAS, "--expect-fingerprint", fingerprint], h.deps)).toBe(1);
    const message = h.err.join("\n");
    expect(message).toContain("Another link operation for this alias is running");
    expect(message).not.toContain("enrollment or revoke");
  } finally { h.restore(); }
});

test("a journalled revoke of a link the Home no longer has exits 4 instead of reporting success", async () => {
  const h = harness([{ status: 404, body: { error: { code: "link_not_found", message: "x" } } }]); try {
    expect(await runLinkCommand(["revoke", "--link-id", LINK, "--purge", "--operation-id", "detach-9"], h.deps)).toBe(4);
    expect(h.out).toEqual([]);
    expect(h.err.join("\n")).toContain("no revoke was journalled");
  } finally { h.restore(); }
});

test("a replayed committed enrollment that planted the Child prints planted: true", async () => {
  const h = harness([{ body: { operationId: OP, state: "committed" } }, { status: 202, body: { ...committed, planted: true } }]); try {
    expect(await runLinkCommand(["add", ALIAS, "--expect-fingerprint", fingerprint, "--operation-id", OP, "--json"], h.deps)).toBe(0);
    expect(JSON.parse(h.out[0]!)).toMatchObject({ linkId: LINK, planted: true, operationId: OP, outcome: "committed" });
  } finally { h.restore(); }
});

test("revoke --operation-id sends it and prints the outcome and the purge receipt", async () => {
  const h = harness([{ body: { linkId: LINK, operationId: "detach-1", outcome: "committed", purged: true } }]); try {
    expect(await runLinkCommand(["revoke", "--link-id", LINK, "--purge", "--operation-id", "detach-1", "--json"], h.deps)).toBe(0);
    expect(h.calls).toEqual([{ method: "DELETE", path: "/api/link/" + LINK, body: { purge: true, operationId: "detach-1" } }]);
    expect(JSON.parse(h.out[0]!)).toEqual({ linkId: LINK, operationId: "detach-1", outcome: "committed", purged: true });
  } finally { h.restore(); }
});

test("a forced revoke with an operation id reports its outcome beside the skipped cleanup", async () => {
  const h = harness([{ body: { linkId: LINK, operationId: "detach-2", outcome: "committed" } }]); try {
    expect(await runLinkCommand(["revoke", "--link-id", LINK, "--force", "--yes", "--operation-id", "detach-2", "--json"], h.deps)).toBe(0);
    expect(h.calls[0]!.body).toEqual({ force: true, operationId: "detach-2" });
    expect(JSON.parse(h.out[0]!)).toMatchObject({ linkId: LINK, remoteCleanup: "skipped", operationId: "detach-2", outcome: "committed" });
  } finally { h.restore(); }
});

test("operations lists, reads and resolves; resolve needs --yes", async () => {
  const entry = { operationId: OP, kind: "enroll", alias: ALIAS, state: "residual" };
  const h = harness([{ body: { operations: [entry] } }, { body: entry }, { body: { ...entry, resolvedAt: "2026-11-13T00:00:00.000Z" } }]); try {
    expect(await runLinkCommand(["operations", "--json"], h.deps)).toBe(0);
    expect(await runLinkCommand(["operations", "--operation-id", OP, "--json"], h.deps)).toBe(0);
    expect(await runLinkCommand(["operations", "resolve", "--operation-id", OP], h.deps)).toBe(2);
    expect(await runLinkCommand(["operations", "resolve", "--operation-id", OP, "--yes", "--json"], h.deps)).toBe(0);
    expect(h.calls.map(call => call.method + " " + call.path)).toEqual(["GET /api/link/operations", "GET /api/link/operations/" + OP, "POST /api/link/operations/" + OP + "/resolve"]);
    expect(JSON.parse(h.out[0]!)).toEqual({ operations: [entry] });
    expect(JSON.parse(h.out[2]!)).toMatchObject({ resolvedAt: "2026-11-13T00:00:00.000Z" });
  } finally { h.restore(); }
});

test.each([
  ["unknown", "ocx link operations resolve --operation-id " + OP + " --yes"],
  ["open", "ocx link revoke --link-id " + LINK + " --operation-id " + OP],
])("a reconnect refused because an %s revoke keeps the link down prints the local next step and exits 5", async (operationState, step) => {
  const h = harness([{ status: 409, body: { error: { code: "link_suspended", message: "server-chosen text" }, operationId: OP, operationState } }]); try {
    expect(await runLinkCommand(["reconnect", "--link-id", LINK], h.deps)).toBe(5);
    const printed = [...h.out, ...h.err].join("\n");
    expect(printed).toContain(step);
    expect(printed).not.toContain("server-chosen text");
  } finally { h.restore(); }
});

test("a link_suspended answer with a malformed operation id prints no command built from it", async () => {
  const h = harness([{ status: 409, body: { error: { code: "link_suspended", message: "x" }, operationId: "-rm -rf", operationState: "unknown" } }]); try {
    expect(await runLinkCommand(["reconnect", "--link-id", LINK], h.deps)).toBe(5);
    const printed = [...h.out, ...h.err].join("\n");
    expect(printed).not.toContain("-rm -rf");
    expect(printed).toContain("ocx link operations");
  } finally { h.restore(); }
});

describe("guidance for journal refusals and unfinished revokes (O1c)", () => {
  const full = (bound?: string) => ({ status: 409, body: { error: { code: "operation_journal_full", message: "server-chosen text" }, ...(bound ? { bound } : {}) } });
  test.each([
    ["unsettled", "ocx link operations resolve --operation-id <id> --yes", "(bound unsettled)"],
    ["recent", "retry once the oldest of them is older", "(bound recent)"],
    [undefined, "ocx link operations", ""],
  ])("add --operation-id refused by a full journal (bound %p) prints local guidance with the code, exit 5", async (bound, guidance, boundNote) => {
    const h = harness([notFound, { body: probe }, { body: confirm }, full(bound)]); try {
      expect(await runLinkCommand(["add", ALIAS, "--expect-fingerprint", fingerprint, "--operation-id", OP], h.deps)).toBe(5);
      const printed = [...h.out, ...h.err].join("\n");
      expect(printed).toContain(guidance);
      expect(printed).toContain("(code operation_journal_full)");
      if (boundNote) expect(printed).toContain(boundNote);
      expect(printed).not.toContain("server-chosen text");
    } finally { h.restore(); }
  });

  test("a repeated revoke that recovery settled unknown names its outcome, its code and the resolve step, exit 5", async () => {
    const h = harness([{ status: 409, body: { error: { code: "operation_interrupted", message: "server-chosen text" }, operationId: "detach-3", outcome: "unknown" } }]); try {
      expect(await runLinkCommand(["revoke", "--link-id", LINK, "--purge", "--operation-id", "detach-3"], h.deps)).toBe(5);
      const printed = [...h.out, ...h.err].join("\n");
      expect(printed).toContain("(operation detach-3: unknown)");
      expect(printed).toContain("(code operation_interrupted)");
      expect(printed).toContain("ocx link operations resolve --operation-id detach-3 --yes");
      expect(printed).not.toContain("server-chosen text");
    } finally { h.restore(); }
  });

  test("a revoke answer that names another operation gets no operation note", async () => {
    const h = harness([{ status: 409, body: { error: { code: "operation_interrupted", message: "x" }, operationId: "someone-else", outcome: "unknown" } }]); try {
      expect(await runLinkCommand(["revoke", "--link-id", LINK, "--purge", "--operation-id", "detach-3"], h.deps)).toBe(5);
      const printed = [...h.out, ...h.err].join("\n");
      expect(printed).not.toContain("someone-else");
      expect(printed).not.toContain("(operation detach-3");
      expect(printed).toContain("(code operation_interrupted)");
    } finally { h.restore(); }
  });

  test("revoke --operation-id refused by a full journal prints the same local guidance", async () => {
    const h = harness([full("unsettled")]); try {
      expect(await runLinkCommand(["revoke", "--link-id", LINK, "--purge", "--operation-id", "detach-4"], h.deps)).toBe(5);
      const printed = [...h.out, ...h.err].join("\n");
      expect(printed).toContain("ocx link operations resolve --operation-id <id> --yes");
      expect(printed).toContain("(code operation_journal_full)");
      expect(printed).not.toContain("server-chosen text");
    } finally { h.restore(); }
  });
});

describe("a journalled revoke refused before anything ran says so (O1c-2)", () => {
  test.each([
    ["operation_mismatch", 409, 5, "used with other parameters"],
    ["link_operation_open", 409, 5, "unfinished revoke holds this link"],
    ["operation_journal_unreadable", 500, 1, "journal"],
  ])("%s prints local text that nothing was changed, with the code", async (code, status, exit, text) => {
    const h = harness([{ status, body: { error: { code, message: "server-chosen text" } } }]); try {
      expect(await runLinkCommand(["revoke", "--link-id", LINK, "--purge", "--operation-id", "detach-5"], h.deps)).toBe(exit);
      const printed = [...h.out, ...h.err].join("\n");
      expect(printed).toContain(text);
      expect(printed).toContain("Nothing was changed");
      expect(printed).toContain("(code " + code + ")");
      expect(printed).not.toContain("server-chosen text");
    } finally { h.restore(); }
  });

  // #8416: a resumed revoke can re-own its retirement receipt before this 409, so the CLI claims only what holds for it.
  test("link_operation_in_progress says the link, its key and the Child were not touched, with the code", async () => {
    const h = harness([{ status: 409, body: { error: { code: "link_operation_in_progress", message: "server-chosen text" } } }]); try {
      expect(await runLinkCommand(["revoke", "--link-id", LINK, "--purge", "--operation-id", "detach-9"], h.deps)).toBe(5);
      const printed = [...h.out, ...h.err].join("\n");
      expect(printed).toContain("Another link operation");
      expect(printed).toContain("did not touch the link, its key or the Child");
      expect(printed).not.toContain("Nothing was changed");
      expect(printed).toContain("(code link_operation_in_progress)");
    } finally { h.restore(); }
  });

  // Only --force can meet the tombstone limit (#8612). A fresh revoke is refused before anything and settles failed_clean, but a
  // resumed one may re-own its retirement receipt first and stay open or unknown (#8416), so the text claims neither.
  test("a forced revoke refused at the tombstone limit says the link and key stay, and to repeat the same id before using a new one", async () => {
    const h = harness([{ status: 409, body: { error: { code: "tombstone_limit", message: "server-chosen text" } } }]); try {
      expect(await runLinkCommand(["revoke", "--link-id", LINK, "--force", "--yes", "--operation-id", "detach-8"], h.deps)).toBe(5);
      const printed = [...h.out, ...h.err].join("\n");
      expect(printed).toContain("waiting for cleanup");
      expect(printed).toContain("did not touch the link, its key or the Child");
      expect(printed).toContain("repeat this revoke with the same operation id first");
      expect(printed).toContain("only if that repeat answers this refusal again");
      expect(printed).not.toContain("if it reads failed_clean");
      expect(printed).not.toContain("Nothing was changed");
      expect(printed).toContain("(code tombstone_limit)");
      expect(printed).not.toContain("server-chosen text");
    } finally { h.restore(); }
  });

  // tombstone_write_failed can come after the tombstone file was written (its permissions step failed), so it stays generic.
  test("a code that cannot promise nothing changed makes no such claim", async () => {
    const h = harness([{ status: 503, body: { error: { code: "tombstone_write_failed", message: "server-chosen text" } } }]); try {
      expect(await runLinkCommand(["revoke", "--link-id", LINK, "--purge", "--operation-id", "detach-6"], h.deps)).toBe(1);
      const printed = [...h.out, ...h.err].join("\n");
      expect(printed).toContain("(code tombstone_write_failed)");
      expect(printed).not.toContain("Nothing was changed");
    } finally { h.restore(); }
  });
});

test("the revoke helper re-checks the outcome itself: a value outside the closed set is never printed", async () => {
  const { journalledRevokeError } = await import("../../src/cli/link");
  const error = new RuntimeApiError("x", 409, { error: { code: "operation_interrupted" }, operationId: "detach-7", outcome: "not-an-outcome; rm -rf" });
  const explained = journalledRevokeError(error, "detach-7") as Error;
  expect(explained.message).not.toContain("not-an-outcome");
  expect(explained.message).toContain("(code operation_interrupted)");
});
