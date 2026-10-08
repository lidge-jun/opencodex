import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCodeNativeAlias } from "../../src/claude/alias";
import { displayModelId } from "../../src/claude/desktop-3p";
import { emptyDesktopProfile, moveDesktopRoute, reconcileDesktopProfile, renderDesktopProfile } from "../../src/claude/desktop-profile";
import { buildPickerModels, createPickerModelSnapshot, type PickerRouteInput } from "../../src/claude/intercept/picker-models";

const routes: PickerRouteInput = {
  nativeSlugs: ["gpt-6-sol"],
  routedModels: [
    { provider: "xai", id: "grok-4.7", contextWindow: 128_000 },
    { provider: "anthropic", id: "claude-sonnet-4-6", contextWindow: 200_000 },
    { provider: "bad--provider", id: "unused" },
  ],
};

test("picker uses routable aliases, candidate labels and context, excluding native Anthropic rows", () => {
  const rows = buildPickerModels(routes);
  expect(rows).toContainEqual({ id: "ocx-claude-xai--grok-4.7", name: "Grok 4.7 (xai)", contextWindow: 128_000 });
  expect(rows).toContainEqual(expect.objectContaining({ id: claudeCodeNativeAlias("gpt-6-sol"), name: "GPT 6 Sol (native)" }));
  expect(rows).toHaveLength(2);
});

test("picker profile order and labels follow the gateway renderer", () => {
  const candidates = [
    { route: "native/gpt-6-sol", label: `${displayModelId("gpt-6-sol")} (native)` },
    { route: "xai/grok-4.7", label: `${displayModelId("grok-4.7")} (xai)`, contextWindow: 128_000 },
  ];
  const initial = reconcileDesktopProfile(emptyDesktopProfile(), candidates);
  const profile = moveDesktopRoute(initial, "native/gpt-6-sol", "haiku", true);
  const rendered = renderDesktopProfile(reconcileDesktopProfile(profile, candidates), candidates);
  const rows = buildPickerModels({ ...routes, routedModels: routes.routedModels.slice(0, 1), profile });
  expect(rows.map(row => row.name)).toEqual(rendered.map(row => row.label));
  expect(rows[0]?.id).toBe("ocx-claude-xai--grok-4.7");
});

test("snapshot persists mode 0600, loads synchronously, and retains last good on loader failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocx-picker-models-"));
  try {
    const path = join(dir, "claude-picker", "models.json");
    let fail = false;
    const load = async () => {
      if (fail) throw new Error("discovery unavailable");
      return routes;
    };
    const first = createPickerModelSnapshot(load, path);
    expect(first.current()).toBeNull();
    await first.refresh();
    const saved = first.current();
    expect(saved?.models).toHaveLength(2);
    // POSIX permission bits only; Windows reports 0o666 for any writable file.
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(saved);
    const restarted = createPickerModelSnapshot(load, path);
    expect(restarted.current()).toEqual(saved);
    fail = true;
    await restarted.refresh();
    expect(restarted.current()).toEqual(saved);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("picker preserves real million-token routed windows without promoting small or unknown routes", () => {
  const rows = buildPickerModels({ nativeSlugs: ["gpt-5.5"], routedModels: [
    { provider: "meta-muse", id: "muse-spark-1.3-contributor", contextWindow: 1_048_576 },
    { provider: "meta-model", id: "muse-spark-1.3-contributor", contextWindow: 1_048_576 },
    { provider: "example", id: "small", contextWindow: 128_000 },
    { provider: "example", id: "unknown" },
  ] });
  expect(rows.map(row => row.id)).toEqual([
    "ocx-claude-native--gpt-5.5",
    "ocx-claude-meta-muse--muse-spark-1.3-contributor[1m]",
    "ocx-claude-meta-model--muse-spark-1.3-contributor[1m]",
    "ocx-claude-example--small", "ocx-claude-example--unknown",
  ]);
  expect(rows[1]?.contextWindow).toBe(1_048_576);
});

test("picker marks long native opt-ins on the prompt-too-long recovery and leaves 272k unmarked", () => {
  // Desktop runners lack CLAUDE_CODE_AUTO_COMPACT_WINDOW; an 872k window is marked anyway because an
  // overflow comes back as `prompt is too long`, which Claude Code compacts on (261009 020).
  const rows = buildPickerModels({
    nativeSlugs: ["gpt-5.5", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-terra"],
    routedModels: [], nativeContextCap: { modelWindows: {
      "gpt-6-astra": 872_000, "gpt-6-sol": 872_000, "gpt-6-luna": 872_000, "gpt-5.6-terra": 922_000,
    } },
  });
  expect(rows.map(row => row.id.endsWith("[1m]"))).toEqual([false, true, true, true, true]);
  expect(rows.map(row => row.contextWindow)).toEqual([272_000, 872_000, 872_000, 872_000, 922_000]);
});

test("picker marks windows from the default compact floor up and leaves smaller routed windows unmarked", () => {
  const rows = buildPickerModels({ nativeSlugs: [], routedModels: [
    { provider: "example", id: "short", contextWindow: 262_144 },
    { provider: "example", id: "below", contextWindow: 829_799 },
    { provider: "example", id: "floor", contextWindow: 829_800 },
    { provider: "example", id: "exact", contextWindow: 1_000_000 },
    { provider: "example", id: "larger", contextWindow: 2_000_000 },
    { provider: "anthropic2", id: "claude-pool-two", contextWindow: 872_000 },
  ] });
  expect(rows.map(row => row.id)).toEqual([
    "ocx-claude-example--short", "ocx-claude-example--below", "ocx-claude-example--floor[1m]",
    "ocx-claude-example--exact[1m]", "ocx-claude-example--larger[1m]", "ocx-claude-anthropic2--claude-pool-two",
  ]);
});
