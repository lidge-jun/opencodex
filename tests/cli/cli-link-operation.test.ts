import { expect, test } from "bun:test";
import { Readable } from "node:stream";
import { runLinkCommand, type LinkCliDeps } from "../../src/cli/link";

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
