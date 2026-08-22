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
    keyPhase: "settled",
    claude: null,
    claudeDesktop: null,
    grok: null,
    native: null,
    nativeSettled: true,
    ...overrides,
  };
}

function rowById(built: ReturnType<typeof buildOverviewRows>, id: string) {
  const found = built.rows.find(row => row.id === id);
  if (!found) throw new Error(`no row for ${id}`);
  return found;
}

test("a null source is unknown, never absent, and is counted in neither total", () => {
  const built = buildOverviewRows(sources());
  for (const id of ["codex", "claude", "claudeDesktop", "grok"]) {
    expect(rowById(built, id).state).toBe("unknown");
  }
  const counts = countOverviewRows(built.rows);
  expect(counts.detected).toBe(0);
  expect(counts.applied).toBe(0);
  // Four, not five: keys is a credential surface and never a client row.
  expect(counts.unknown).toBe(4);
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
  const desktopNative = [{
    clientId: "claude-desktop" as const,
    state: "current" as const,
    installed: true,
    configPath: "/tmp/desktop",
    desiredEnabled: true,
    disableBlocked: null,
  }];
  const served = buildOverviewRows(
    sources({ native: desktopNative, claudeDesktop: { desiredEnabled: true, installed: true, applied: true, stale: false, activeProfile: true } }),
  );
  expect(rowById(served, "claudeDesktop").state).toBe("current");

  const notServed = buildOverviewRows(
    sources({ native: desktopNative, claudeDesktop: { desiredEnabled: true, installed: true, applied: true, stale: false, activeProfile: false } }),
  );
  expect(rowById(notServed, "claudeDesktop").state).toBe("stale");

  const drifted = buildOverviewRows(
    sources({ native: desktopNative, claudeDesktop: { desiredEnabled: true, installed: true, applied: true, stale: true, activeProfile: true } }),
  );
  expect(rowById(drifted, "claudeDesktop").state).toBe("stale");

  // Undeterminable must not downgrade a healthy applied profile.
  const unknownProfile = buildOverviewRows(
    sources({ native: desktopNative, claudeDesktop: { desiredEnabled: true, installed: true, applied: true, stale: false, activeProfile: null } }),
  );
  expect(rowById(unknownProfile, "claudeDesktop").state).toBe("current");

  // Desired OFF with the gateway gone is absent.
  const desiredOff = buildOverviewRows(
    sources({
      native: [{ ...desktopNative[0]!, desiredEnabled: false, state: "absent" }],
      claudeDesktop: { desiredEnabled: false, installed: true, applied: false, stale: false, activeProfile: false },
    }),
  );
  expect(rowById(desiredOff, "claudeDesktop")).toMatchObject({
    state: "absent",
    applied: false,
    toggleOn: false,
    detailKey: "integrations.detail.desktopDesiredOff",
  });
});

test("Claude Desktop: desired-off with a still-selected gateway is stale cleanup-pending", () => {
  const desktopNative = [{
    clientId: "claude-desktop" as const,
    state: "current" as const,
    installed: true,
    configPath: "/tmp/desktop",
    desiredEnabled: false,
    disableBlocked: null,
  }];
  const leftoverGateway = buildOverviewRows(
    sources({
      native: desktopNative,
      claudeDesktop: {
        desiredEnabled: false,
        installed: true,
        applied: true,
        stale: false,
        drift: true,
        driftReason: "desired_off_gateway_selected",
        activeProfile: true,
      },
    }),
  );
  expect(rowById(leftoverGateway, "claudeDesktop")).toMatchObject({
    state: "stale",
    applied: true,
    toggleOn: false,
    detailKey: "integrations.detail.desktopDesiredOffCleanupPending",
  });
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

  const counts = countOverviewRows(rows.rows);
  expect(counts.detected).toBe(5);
  expect(counts.applied).toBe(2);
  expect(counts.stale).toBe(1);
});

test("every client counts toward the summary, not just the file clients", () => {
  const rows = buildOverviewRows(sources({
    clients: [fileStatus({ clientId: "opencode", state: "current" })],
    codex: { routingInjected: true, status: "at-risk" },
    keyCount: 2,
    claude: { enabled: true },
    claudeDesktop: { desiredEnabled: true, installed: true, applied: true, stale: true, activeProfile: true },
    native: [{
      clientId: "claude-desktop",
      state: "current",
      installed: true,
      configPath: "/tmp/desktop",
      desiredEnabled: true,
      disableBlocked: null,
    }, {
      clientId: "claude",
      state: "current",
      installed: true,
      configPath: "/tmp/config",
      desiredEnabled: true,
      disableBlocked: null,
    }, {
      clientId: "grok",
      state: "current",
      installed: true,
      configPath: "/tmp/grok",
      desiredEnabled: true,
      disableBlocked: null,
    }],
    grok: { present: true, models: [{}, {}] },
  }));
  const counts = countOverviewRows(rows.rows);
  // codex + claude + desktop + grok + opencode. Keys are deliberately absent:
  // an issued credential is not an applied client.
  expect(counts.applied).toBe(5);
  expect(counts.stale).toBe(1);
  expect(counts.unknown).toBe(0);
});

test("an unsettled file list renders unknown rows instead of dropping them", () => {
  const built = buildOverviewRows(sources({ clients: [], clientsSettled: false }));
  expect(built.rows).toHaveLength(15);
  expect(rowById(built, "omp").state).toBe("unknown");
  expect(rowById(built, "mcode").state).toBe("unknown");
  expect(rowById(built, "zcode").state).toBe("unknown");
  expect(rowById(built, "prime").state).toBe("unknown");
  expect(rowById(built, "kimi").state).toBe("unknown");
  expect(rowById(built, "dsh")).toMatchObject({
    hash: "integrations/dsh",
    labelKey: "integrations.tab.dsh",
    state: "unknown",
  });

  // Once settled, a client the server omitted is genuinely gone.
  const settled = buildOverviewRows(sources({ clients: [], clientsSettled: true }));
  expect(settled.rows).toHaveLength(4);
  expect(settled.rows.some(row => row.hash === "integrations/keys")).toBe(false);
});

test("each row points at its own tab", () => {
  const rows = buildOverviewRows(sources({ clientsSettled: false }));
  expect(rowById(rows, "codex").hash).toBe("integrations/codex");
  expect(rowById(rows, "claude").hash).toBe("integrations/claude");
  expect(rowById(rows, "claudeDesktop").hash).toBe("integrations/claude/desktop");
  expect(rowById(rows, "grok").hash).toBe("integrations/grok");
  expect(rowById(rows, "hermes").hash).toBe("integrations/hermes");
  expect(rowById(rows, "omp").hash).toBe("integrations/omp");
  expect(rowById(rows, "dsh").hash).toBe("integrations/dsh");
});
