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
  const h = harness([{ body: { operationId: OP, state: "unknown" } }, { status: 500, body: { error: { code: "key_issue_uncertain", message: "server text" }, operationId: OP, outcome: "unknown", residual: true, residualKind: "plant", linkId: LINK, recovery: "server recovery text" } }]); try {
    expect(await runLinkCommand(["add", ALIAS, "--expect-fingerprint", fingerprint, "--operation-id", OP], h.deps)).toBe(1);
    const message = h.err.join("\n");
    // Bound to the reserved link id the replay names (#8691 final review).
    expect(message).toContain("~/.cache/opencodex/bin/ocx-child detach --purge --expect-link " + LINK);
    expect(message).toContain('ocx-child.exe" detach --purge --expect-link ' + LINK);
    // %VAR% and a bare quoted path are Command Prompt syntax; PowerShell would need & and $env:.
    expect(message).toContain("in Command Prompt");
    expect(message).not.toContain("ocx disconnect");
    expect(message).not.toContain("server recovery text");
    expect(message).toContain("operation " + OP + ": unknown");
  } finally { h.restore(); }
});

test.each(["child_port_busy", "child_external_provider_conflict"])("a %s answer whose plant rollback failed gives purge guidance, not 'no Child files were modified'", async errorCode => {
  const h = harness([notFound, { body: probe }, { body: confirm }, { status: 409, body: { error: { code: errorCode, message: "server text" }, operationId: OP, outcome: "residual", residual: true, residualKind: "plant", linkId: LINK } }]); try {
    expect(await runLinkCommand(["add", ALIAS, "--expect-fingerprint", fingerprint, "--operation-id", OP], h.deps)).toBe(1);
    const message = h.err.join("\n");
    expect(message).toContain("ocx-child detach --purge --expect-link " + LINK);
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
      // confirm-host already wrote the known_hosts pin before this apply, so only the apply changed nothing.
      expect(printed).toContain("The apply changed nothing");
      expect(printed).not.toContain("Nothing was changed");
      expect(printed).not.toContain("server-chosen text");
    } finally { h.restore(); }
  });

  test.each([
    ["full_install_present", 409, "refused it before the apply changed the Child, a key or a link"],
    ["full_install_census_failed", 502, "the apply changed no key, link or Child file"],
  ])("add --require-ephemeral refused with %s claims only what the apply left alone (its journal entry is recorded)", async (code, status, text) => {
    const h = harness([notFound, { body: probe }, { body: confirm }, { status, body: { error: { code, message: "server-chosen text" } } }]); try {
      expect(await runLinkCommand(["add", ALIAS, "--expect-fingerprint", fingerprint, "--operation-id", OP, "--require-ephemeral"], h.deps)).not.toBe(0);
      const printed = [...h.out, ...h.err].join("\n");
      expect(printed).toContain(text);
      expect(printed).not.toContain("nothing was changed");
      expect(printed).not.toContain("before any change");
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
      // A revoke has no step before the refused request, so here nothing was changed.
      expect(printed).toContain("Nothing was changed");
      expect(printed).not.toContain("server-chosen text");
    } finally { h.restore(); }
  });
});

describe("closed guidance for the refusals of a journalled revoke (O1c)", () => {
  test.each([
    ["operation_mismatch", 409, 5, "used with other parameters"],
    ["link_operation_open", 409, 5, "unfinished revoke holds this link"],
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

  // Only --force can meet the tombstone limit (#8612). A fresh revoke is refused before it touches the link, its key or the Child and settles failed_clean, but a
  // resumed one may re-own its retirement receipt first and stay open or unknown (#8416), so the text claims neither.
  test("a forced revoke refused at the tombstone limit claims only that this attempt revoked no key, removed no record and did not contact the Child, and to repeat the same id before using a new one", async () => {
    const h = harness([{ status: 409, body: { error: { code: "tombstone_limit", message: "server-chosen text" } } }]); try {
      expect(await runLinkCommand(["revoke", "--link-id", LINK, "--force", "--yes", "--operation-id", "detach-8"], h.deps)).toBe(5);
      const printed = [...h.out, ...h.err].join("\n");
      expect(printed).toContain("waiting for cleanup");
      // The commit-time check (#8662) meets the limit after this attempt stopped the tunnel: only key, record and Child are claimed.
      expect(printed).toContain("revoked no key, removed no record and did not contact the Child");
      // An earlier attempt of a resumed revoke may already have revoked the key and stopped the tunnel (#8416).
      expect(printed).not.toContain("stay active");
      expect(printed).toContain("repeat this revoke with the same operation id");
      expect(printed).toContain("although capacity is free");
      expect(printed).toContain("link_retirement_owned");
      // That answer means some unfinished removal holds the link, not necessarily this operation (#8416).
      expect(printed).not.toContain("still belongs to this id");
      expect(printed).toContain("an unfinished removal holds this link");
      expect(printed).toContain("the revoke of this link that owns it, whatever its recorded state");
      expect(printed).toContain("ocx link revoke --link-id " + LINK + " --operation-id detach-8 --force --yes");
      expect(printed).toContain("ocx link recover --link-id");
      expect(printed).toContain("ocx link recover --forget --link-id <id> --yes");
      expect(printed).toContain("ocx link operations --json");
      expect(printed).not.toContain("lists this link's revokes");
      expect(printed).toContain("ocx link operations");
      // Every printed command runs as printed: revoke needs --link-id (and --yes with --force).
      expect(printed).toContain("ocx link revoke --link-id " + LINK + " --force --yes without --operation-id");
      expect(printed).not.toContain("ocx link revoke --force");
      expect(printed).not.toContain("the refusal was recorded");
      expect(printed).not.toContain("if it reads failed_clean");
      expect(printed).not.toContain("Nothing was changed");
      expect(printed).toContain("(code tombstone_limit)");
      expect(printed).not.toContain("server-chosen text");
    } finally { h.restore(); }
  });

  // A replay that follows a resumed removal can read a damaged journal after the removal finished (#8416), so no state claim.
  test("operation_journal_unreadable names the way out, claims nothing about state, and says what link_not_found then means", async () => {
    const h = harness([{ status: 500, body: { error: { code: "operation_journal_unreadable", message: "server-chosen text" } } }]); try {
      expect(await runLinkCommand(["revoke", "--link-id", LINK, "--purge", "--operation-id", "detach-11"], h.deps)).toBe(1);
      const printed = [...h.out, ...h.err].join("\n");
      expect(printed).toContain("Keep a copy, move it aside");
      expect(printed).toContain("link_not_found");
      // The way out runs as printed: a forced revoke needs the link id and --yes.
      expect(printed).toContain("ocx link revoke --link-id " + LINK + " --force --yes, without --operation-id");
      expect(printed).not.toContain("ocx link revoke --force without --operation-id");
      expect(printed).not.toContain("Nothing was changed");
      expect(printed).toContain("(code operation_journal_unreadable)");
      expect(printed).not.toContain("server-chosen text");
    } finally { h.restore(); }
  });

  // Generic codes still get a next step; where a path's answer differs, the text says what a repeat's answer means (the
  // table in structure/remote-link.md). link_changed can come from a stale retirement receipt that no repeat clears (#8678).
  test.each([
    ["operation_journal_failed", 500, 1, ["then repeat the revoke with the same operation id", "if that answers link_retirement_owned", "this id may still own the removal"]],
    ["link_changed", 409, 5, ["no longer matches", "ocx link status", "repeat the revoke with the same operation id", "If it answers link_changed again", "ocx link routes", "A new operation id can remove it only when no unfinished removal"]],
  ])("%s names a next step, conditional where a repeat can answer the same code, and claims nothing about state", async (code, status, exit, parts) => {
    const h = harness([{ status, body: { error: { code, message: "server-chosen text" } } }]); try {
      expect(await runLinkCommand(["revoke", "--link-id", LINK, "--purge", "--operation-id", "detach-12"], h.deps)).toBe(exit);
      const printed = [...h.out, ...h.err].join("\n");
      for (const part of parts) expect(printed).toContain(part);
      expect(printed).not.toContain("changed while this revoke ran");
      expect(printed).not.toContain("Nothing was changed");
      expect(printed).toContain("(code " + code + ")");
      expect(printed).not.toContain("server-chosen text");
    } finally { h.restore(); }
  });

  // An unknown can arise before the receipt claim (a disconnect timeout, a journal write failure), so the resume is conditional.
  test("an unknown outcome says to repeat the same id before resolving, which resumes a removal only if this id still owns one", async () => {
    const h = harness([{ status: 502, body: { error: { code: "remote_disconnect_failed", message: "x" }, operationId: "detach-13", outcome: "unknown" } }]); try {
      expect(await runLinkCommand(["revoke", "--link-id", LINK, "--purge", "--operation-id", "detach-13"], h.deps)).toBe(1);
      const printed = [...h.out, ...h.err].join("\n");
      const repeat = printed.indexOf("repeat the revoke with the same operation id");
      const resolve = printed.indexOf("ocx link operations resolve --operation-id detach-13 --yes");
      expect(repeat).toBeGreaterThan(-1);
      expect(resolve).toBeGreaterThan(repeat);
      expect(printed).toContain("if this id still owns an unfinished removal, the repeat resumes it");
      expect(printed).toContain("ocx link operations --operation-id detach-13 shows its state");
      // A resume that failed and could not settle leaves the entry open, which resolve refuses: only unknown or residual resolve.
      expect(printed).toContain("if it reads unknown or residual, check the Child, then run ocx link operations resolve --operation-id detach-13 --yes");
      // A resume whose record was already gone settles committed, and clearing its receipt can still fail: one more repeat clears it.
      expect(printed).toContain("if it reads committed, the removal finished: repeat it once more to clear what it left");
      expect(printed).toContain("if it reads open, fix what stopped the revoke (for example the journal's disk) and repeat it with the same operation id");
      expect(printed).not.toContain("it resumes a removal this id still owns");
    } finally { h.restore(); }
  });

  // #8662's link-bound refusals reach the CLI only as a hint: each validated hint in the closed set gets the CLI's own text, with
  // its outcome; child_disconnect_pending ends unknown, so its repeat guidance stays conditional.
  // A failed_clean entry only replays its answer, so its next step is a new operation id; an unknown one resumes under the same id.
  test.each([
    ["child_link_mismatch", "failed_clean", ["who it belongs to or what state it is in", "Do not disconnect it there", "ocx connect status --json (on a lightweight Child, connect status --json of its planted ocx-child, ~/.cache/opencodex/bin/ocx-child, or in Command Prompt on Windows %LOCALAPPDATA%\\opencodex\\bin\\ocx-child.exe, or %USERPROFILE%\\.cache\\opencodex\\bin\\ocx-child.exe where LOCALAPPDATA is not set)", "revoke this link with --force once any enrollment of this link has finished", "If it shows this link's id, a connect or key rotation of it may be in progress: let it finish on the Child, then revoke again with a new operation id (repeating this id only replays this answer); if the same answer comes back, revoke this link with --force once any enrollment of this link has finished", "if you cannot, or the machine cannot be reached, revoke this link with --force once any enrollment of this link has finished", "revoke again with a new operation id (repeating this id only replays this answer)"], ["If it joined this Home by itself", "with the same operation id", "of it is in progress"]],
    ["child_link_mismatch", "unknown", ["Do not disconnect it there", "let it finish on the Child, then repeat the revoke with the same operation id", "repair it on the Child, then repeat the revoke with the same operation id"], ["revoke again with a new operation id (repeating this id only replays this answer)"]],
    ["child_residual", "failed_clean", ["keeps records it cannot restore", "Do not run a plain ocx-child detach on it", "interrupted attach of another link", "Revoke this link with --force"], ["~/.cache/opencodex/bin/ocx-child detach", "with the same operation id", "Inspect them first"]],
    ["child_disconnect_pending", "unknown", ["unfinished disconnect", "may be partly cleaned", "Check it with ocx connect status --json, which cannot say whose disconnect it is", "only if it shows no connection, finish it there with ocx disconnect, then repeat the revoke with the same operation id", "If it shows any link, a hub or another Home, if its state cannot be read, or if the machine cannot be reached, leave it and revoke this link with --force", "if this id still owns an unfinished removal, the repeat resumes it"], ["revoke again with a new operation id (repeating this id only replays this answer)", "Check whose it is", "this link's id or no connection"]],
    ["expect_link_unsupported", "failed_clean", ["older than --expect-link", "another Home-initiated link", "Update OpenCodex on a full install, then revoke again with a new operation id (repeating this id only replays this answer)", "an older planted ocx-child cannot be updated from this Home", "Otherwise revoke this link with --force", "Revoking the other link instead is no way out unless you mean to end it: no status check can show it is stale", "under the same pinned host key its revoke is refused the same way", "through a shared route it disconnects the machine if the machine runs that link"], ["with the same operation id", "only if it is stale too", "does not show its id"]],
    ["expect_link_unsupported", "unknown", ["Update OpenCodex on a full install, then repeat the revoke with the same operation id"], ["revoke again with a new operation id (repeating this id only replays this answer)"]],
  ] as const)("a journalled revoke refused with hint %s and outcome %s prints the CLI's own text for it", async (hint, outcome, parts, absent) => {
    const h = harness([{ status: 502, body: { error: { code: "remote_disconnect_failed", hint, message: "server-chosen text" }, operationId: "detach-20", outcome } }]); try {
      expect(await runLinkCommand(["revoke", "--link-id", LINK, "--operation-id", "detach-20"], h.deps)).toBe(1);
      const printed = [...h.out, ...h.err].join("\n");
      for (const part of parts) expect(printed).toContain(part);
      for (const part of absent) expect(printed).not.toContain(part);
      expect(printed).toContain("(code remote_disconnect_failed, hint " + hint + ")");
      expect(printed).not.toContain("server-chosen text");
    } finally { h.restore(); }
  });

  // A plain revoke (no operation id) gets the same closed-set text; its next step is simply to revoke again.
  test.each([
    ["child_link_mismatch", ["Do not disconnect it there", "let it finish on the Child, then revoke again", "if you cannot, or the machine cannot be reached, revoke this link with --force"]],
    ["child_residual", ["Do not run a plain ocx-child detach on it", "Revoke this link with --force"]],
    ["child_disconnect_pending", ["Check it with ocx connect status --json, which cannot say whose disconnect it is", "only if it shows no connection, finish it there with ocx disconnect, then revoke again"]],
    ["expect_link_unsupported", ["Update OpenCodex on a full install, then revoke again"]],
  ] as const)("a plain revoke refused with hint %s prints the CLI's own text for it", async (hint, parts) => {
    const h = harness([{ status: 502, body: { error: { code: "remote_disconnect_failed", hint, message: "server-chosen text" } } }]); try {
      expect(await runLinkCommand(["revoke", "--link-id", LINK], h.deps)).toBe(1);
      const printed = [...h.out, ...h.err].join("\n");
      expect(printed).toContain("Link revoke did not complete (code remote_disconnect_failed, hint " + hint + ")");
      for (const part of parts) expect(printed).toContain(part);
      expect(printed).not.toContain("operation id");
      expect(printed).not.toContain("server-chosen text");
    } finally { h.restore(); }
  });

  test.each(["ssh_failed", "constructor"])("a plain revoke whose hint is outside the closed set (%s) keeps the generic failure", async hint => {
    const h = harness([{ status: 502, body: { error: { code: "remote_disconnect_failed", hint, message: "server-chosen text" } } }]); try {
      expect(await runLinkCommand(["revoke", "--link-id", LINK], h.deps)).toBe(1);
      const printed = [...h.out, ...h.err].join("\n");
      expect(printed).toContain("Link management request failed (502)");
      expect(printed).not.toContain("Link revoke did not complete");
      expect(printed).not.toContain("server-chosen text");
    } finally { h.restore(); }
  });


  test.each(["ssh_failed", "constructor", "/home/someone/path"])("a hint outside the closed set (%s) adds no text", async hint => {
    const h = harness([{ status: 502, body: { error: { code: "remote_disconnect_failed", hint, message: "server-chosen text" }, operationId: "detach-21", outcome: "unknown" } }]); try {
      await runLinkCommand(["revoke", "--link-id", LINK, "--operation-id", "detach-21"], h.deps);
      const printed = [...h.out, ...h.err].join("\n");
      expect(printed).toContain("(code remote_disconnect_failed)");
      expect(printed).not.toContain("hint ");
      expect(printed).not.toContain("/home/someone");
    } finally { h.restore(); }
  });

  // #8416's refusals for an interrupted removal: the owner and the way out live only in the server's message, which is dropped.
  test.each([
    ["link_retirement_owned", ["unfinished removal holds this link", "the revoke of this link that owns it, whatever its recorded state", "ocx link operations --json", "ocx link revoke --link-id " + LINK + " --force --yes without --operation-id", "If no journalled operation owns it", "ocx link revoke --link-id " + LINK + " without --operation-id and without --force"]],
    ["link_retirement_mode_mismatch", ["interrupted in another mode", "the revoke that started it", "ocx link revoke --link-id " + LINK + " --force --yes without --operation-id"]],
  ])("%s prints closed guidance that names the way out and makes no claim about state", async (code, parts) => {
    const h = harness([{ status: 409, body: { error: { code, message: "server-chosen text" } } }]); try {
      expect(await runLinkCommand(["revoke", "--link-id", LINK, "--purge", "--operation-id", "detach-10"], h.deps)).toBe(5);
      const printed = [...h.out, ...h.err].join("\n");
      for (const part of parts) expect(printed).toContain(part);
      expect(printed).not.toContain("<link id>");
      expect(printed).toContain("(code " + code + ")");
      expect(printed).not.toContain("Nothing was changed");
      expect(printed).not.toContain("cleanup ran");
      expect(printed).not.toContain("server-chosen text");
    } finally { h.restore(); }
  });

  // tombstone_write_failed can come after the tombstone file was written (its permissions step failed), before the first intent or
  // at the commit step after stopLink (#8662), where the drop of that file is best effort; so it stays generic.
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

test("the revoke helper prints only a validated link id in its commands, a placeholder otherwise", async () => {
  const { journalledRevokeError } = await import("../../src/cli/link");
  const error = new RuntimeApiError("x", 409, { error: { code: "link_retirement_owned" } });
  const explained = journalledRevokeError(error, "detach-14", "lnk_; rm -rf ~") as Error;
  expect(explained.message).not.toContain("rm -rf");
  expect(explained.message).toContain("ocx link revoke --link-id <link id> --force --yes without --operation-id");
});
