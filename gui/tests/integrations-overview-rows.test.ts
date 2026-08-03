import { expect, test } from "bun:test";
import {
  buildOverviewRows,
  countOverviewRows,
  type OverviewSources,
} from "../src/pages/integrations/overview-clients";
import type { IntegrationStatus } from "../src/pages/integrations/integration-api";

/**
 * The overview's whole job is to not lie about what is applied, so these tests
 * pin the mappings that are easy to get subtly wrong: an unsettled source that
 * looks absent, a Codex routing state read off the wrong field, and a Desktop
 * profile that exists but is not the one Desktop serves.
 */

function fileStatus(overrides: Partial<IntegrationStatus> = {}): IntegrationStatus {
  return {
    clientId: "hermes",
    state: "absent",
    installed: true,
    configPath: "/tmp/home/.hermes/config.yaml",
    snapshotCount: 0,
    retentionDegraded: false,
    ...overrides,
  };
}

function sources(overrides: Partial<OverviewSources> = {}): OverviewSources {
  return {
    clients: [],
    clientsSettled: true,
    codex: null,
    keyCount: null,
    claude: null,
    claudeDesktop: null,
    grok: null,
    ...overrides,
  };
}

function rowById(rows: ReturnType<typeof buildOverviewRows>, id: string) {
  const found = rows.find(row => row.id === id);
  if (!found) throw new Error(`no row for ${id}`);
  return found;
}

test("a null source is unknown, never absent, and is counted in neither total", () => {
  const rows = buildOverviewRows(sources());
  for (const id of ["codex", "keys", "claude", "claudeDesktop", "grok"]) {
    expect(rowById(rows, id).state).toBe("unknown");
  }
  const counts = countOverviewRows(rows);
  expect(counts.detected).toBe(0);
  expect(counts.applied).toBe(0);
  expect(counts.unknown).toBe(5);
});

test("Codex reads routingInjected, not status", () => {
  // `protected` is about surviving a reboot. With no injected routing the
  // proxy is not in Codex's path, and the card must say so.
  const notInjected = buildOverviewRows(
    sources({ codex: { routingInjected: false, status: "protected" } }),
  );
  expect(rowById(notInjected, "codex").state).toBe("absent");
  expect(rowById(notInjected, "codex").applied).toBe(false);

  const injected = buildOverviewRows(
    sources({ codex: { routingInjected: true, status: "at-risk" } }),
  );
  expect(rowById(injected, "codex").state).toBe("current");
  expect(rowById(injected, "codex").applied).toBe(true);

  const broken = buildOverviewRows(
    sources({ codex: { routingInjected: true, status: "error" } }),
  );
  expect(rowById(broken, "codex").state).toBe("stale");
});

test("Claude Desktop: applied but not the served profile reads as stale", () => {
  const served = buildOverviewRows(
    sources({ claudeDesktop: { applied: true, stale: false, activeProfile: true } }),
  );
  expect(rowById(served, "claudeDesktop").state).toBe("current");

  const notServed = buildOverviewRows(
    sources({ claudeDesktop: { applied: true, stale: false, activeProfile: false } }),
  );
  expect(rowById(notServed, "claudeDesktop").state).toBe("stale");

  const drifted = buildOverviewRows(
    sources({ claudeDesktop: { applied: true, stale: true, activeProfile: true } }),
  );
  expect(rowById(drifted, "claudeDesktop").state).toBe("stale");

  // Undeterminable must not downgrade a healthy applied profile.
  const unknownProfile = buildOverviewRows(
    sources({ claudeDesktop: { applied: true, stale: false, activeProfile: null } }),
  );
  expect(rowById(unknownProfile, "claudeDesktop").state).toBe("current");
});

test("file clients keep their existing badge and applied semantics", () => {
  const rows = buildOverviewRows(sources({
    clients: [
      fileStatus({ clientId: "opencode", state: "current" }),
      fileStatus({ clientId: "pi", state: "stale" }),
      fileStatus({ clientId: "hermes", state: "conflict" }),
      fileStatus({ clientId: "openclaw", state: "absent" }),
      fileStatus({ clientId: "kimi", state: "absent", installed: false }),
      fileStatus({ clientId: "gajae", state: "unsafe" }),
    ],
  }));
  expect(rowById(rows, "opencode").applied).toBe(true);
  expect(rowById(rows, "pi").applied).toBe(true);
  expect(rowById(rows, "hermes").applied).toBe(false);
  // An uninstalled client collapses to the not-installed badge, as the badge
  // component already did, so the grid and the counts cannot disagree.
  expect(rowById(rows, "kimi").state).toBe("not-installed");
  expect(rowById(rows, "kimi").installed).toBe(false);
  expect(rowById(rows, "gajae").state).toBe("unsafe");

  const counts = countOverviewRows(rows);
  expect(counts.detected).toBe(5);
  expect(counts.applied).toBe(2);
  expect(counts.stale).toBe(1);
});

test("every client counts toward the summary, not just the file six", () => {
  const rows = buildOverviewRows(sources({
    clients: [fileStatus({ clientId: "opencode", state: "current" })],
    codex: { routingInjected: true, status: "at-risk" },
    keyCount: 2,
    claude: { enabled: true },
    claudeDesktop: { applied: true, stale: true, activeProfile: true },
    grok: { present: true, models: [{}, {}] },
  }));
  const counts = countOverviewRows(rows);
  // codex + keys + claude + desktop + grok + opencode
  expect(counts.applied).toBe(6);
  expect(counts.stale).toBe(1);
  expect(counts.unknown).toBe(0);
});

test("an unsettled file list renders unknown rows instead of dropping them", () => {
  const rows = buildOverviewRows(sources({ clients: [], clientsSettled: false }));
  expect(rows).toHaveLength(11);
  expect(rowById(rows, "kimi").state).toBe("unknown");

  // Once settled, a client the server omitted is genuinely gone.
  const settled = buildOverviewRows(sources({ clients: [], clientsSettled: true }));
  expect(settled).toHaveLength(5);
});

test("each row points at its own tab", () => {
  const rows = buildOverviewRows(sources({ clientsSettled: false }));
  expect(rowById(rows, "codex").hash).toBe("integrations/codex");
  expect(rowById(rows, "keys").hash).toBe("integrations/keys");
  expect(rowById(rows, "claude").hash).toBe("integrations/claude");
  expect(rowById(rows, "claudeDesktop").hash).toBe("integrations/claude/desktop");
  expect(rowById(rows, "grok").hash).toBe("integrations/grok");
  expect(rowById(rows, "hermes").hash).toBe("integrations/hermes");
});
