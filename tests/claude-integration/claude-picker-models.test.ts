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
