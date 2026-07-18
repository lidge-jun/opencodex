import { describe, expect, test } from "bun:test";
import { railStatusCls, statusLabel } from "../gui/src/components/provider-workspace/ProviderRail";
import type { WorkspaceItem } from "../gui/src/provider-workspace/catalog";
import type { TFn } from "../gui/src/i18n";

const t = ((key: string) => ({
  "prov.disabledBadge": "Disabled",
  "pws.status.ready": "Ready",
  "pws.status.needsSetup": "Needs setup",
}[key] ?? key)) as TFn;

function item(overrides: Partial<WorkspaceItem> = {}): WorkspaceItem {
  return {
    name: "example",
    adapter: "openai-chat",
    baseUrl: "https://api.example.com/v1",
    authMode: "key",
    hasApiKey: true,
    ...overrides,
  };
}

describe("provider rail status semantics", () => {
  test("maps visible labels and reinforcing dot classes from the same status", () => {
    expect(statusLabel(item(), t)).toBe("Ready");
    expect(railStatusCls(item())).toContain("--active");
    expect(statusLabel(item({ hasApiKey: false }), t)).toBe("Needs setup");
    expect(railStatusCls(item({ hasApiKey: false }))).toContain("--warning");
    expect(statusLabel(item({ disabled: true }), t)).toBe("Disabled");
    expect(railStatusCls(item({ disabled: true }))).toContain("--inactive");
  });
});

describe("provider rail source contract", () => {
  test("has one page-owned action surface and one option focus model", async () => {
    const shell = await Bun.file("gui/src/components/provider-workspace/ProviderWorkspaceShell.tsx").text();
    expect(shell).not.toContain('className="pws-rail-header"');
    expect(shell).not.toContain('className="pws-rail-title"');
    expect(shell).not.toMatch(/className="pws-rail-list"[\s\S]{0,160}tabIndex=\{0\}/);
    expect(shell).toContain('className="pws-shell-container"');
    expect(shell).toContain('className="pws-rail-group-label"');
    expect(shell).toContain('className="pws-rail-group-count"');
    expect(shell).toContain("railTabbableName");
    expect(shell).toContain("onFocus={() => setRailFocusName(item.name)}");
  });

  test("uses icon, two-line copy, and trail without a chevron sibling", async () => {
    const rail = await Bun.file("gui/src/components/provider-workspace/ProviderRail.tsx").text();
    expect(rail).toContain('className="providers-workspace-rail-copy"');
    expect(rail).toContain('className="providers-workspace-rail-primary"');
    expect(rail).toContain('className="providers-workspace-rail-secondary"');
    expect(rail).not.toContain("providers-workspace-rail-chevron");
    expect(rail).not.toContain("<IconChevron");
    expect(rail).toContain('title={nameTitle}');
  });

  test("pins no-wrap, token, container, and overflow protections", async () => {
    const css = await Bun.file("gui/src/styles/provider-workspace-shell.css").text();
    expect(css).not.toContain("var(--fg");
    expect(css).toContain("container-name: provider-workspace");
    expect(css).toContain(".main-inner:has(.pws-shell-container)");
    expect(css).toMatch(/\.providers-workspace-rail-name-label\s*\{[^}]*white-space:\s*nowrap[^}]*text-overflow:\s*ellipsis/s);
    expect(css).toMatch(/\.providers-workspace-rail-secondary\s*\{[^}]*white-space:\s*nowrap[^}]*text-overflow:\s*ellipsis/s);
    expect((css.match(/\.providers-workspace-rail-row\s*\{/g) ?? []).length).toBe(1);
  });

  test("preserves only the exact workspace subroute on page synchronization", async () => {
    const app = await Bun.file("gui/src/App.tsx").text();
    expect(app).toContain('rawHash === "providers/workspace"');
    expect(app).toContain("hashBelongsToPage(rawHash, nextPage)");
    expect(app).toContain("hashBelongsToPage(rawHash, page)");
    expect(app).not.toContain("window.location.hash !== nextHash");
  });
});
