import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";

// Workflow wiring for the Linux packaged-shell E2E. The driver's own behaviour is covered by
// linux-desktop-packaged-e2e.test.ts; this file only reads .github/workflows/ci.yml.
describe("Linux packaged desktop E2E in CI", () => {
  test("CI scopes the real package build and keeps the E2E unprivileged", () => {
    const workflow = Bun.YAML.parse(readFileSync(repoPath(".github", "workflows", "ci.yml"), "utf8")) as {
      permissions?: Record<string, string>;
      jobs?: Record<string, {
        if?: string;
        outputs?: Record<string, string>;
        steps?: Array<{
          name?: string;
          uses?: string;
          if?: string;
          run?: string;
          env?: Record<string, string>;
          with?: Record<string, unknown>;
        }>;
      }>;
    };
    expect(workflow.permissions).toEqual({ contents: "read" });
    const changes = workflow.jobs?.changes;
    expect(changes?.outputs?.desktop).toBe("${{ steps.scope.outputs.desktop }}");
    const filter = changes?.steps?.find(step => step.name === "Detect changed areas");
    const filters = String(filter?.with?.filters ?? "");
    expect(filters).toContain("desktop:");
    expect(filters).toContain("'desktop/**'");
    expect(filters).toContain("'src/**'");
    expect(filters).toContain("'.github/workflows/ci.yml'");

    const shell = workflow.jobs?.["desktop-shell"];
    expect(shell?.if).toContain("needs.changes.outputs.desktop == 'true'");
    const checkResources = shell?.steps?.find(step => step.name === "Prepare desktop check resources");
    expect(checkResources?.run).toContain("binaries/ocx-");
    expect(checkResources?.run).not.toContain("resources/sidecar/ocx");
    const preserve = shell?.steps?.find(step => step.name === "Preserve the compiled Linux sidecar");
    expect(preserve?.run).toContain("chmod +x desktop/scripts/appimage-patchelf.py");
    const appImageBuild = shell?.steps?.find(step => step.name === "Build Linux AppImage");
    const debBuild = shell?.steps?.find(step => step.name === "Build Linux deb");
    expect(appImageBuild?.env?.CARGO_TARGET_DIR).toContain("opencodex-appimage-target");
    expect(appImageBuild?.env?.PATCHELF).toContain("desktop/scripts/appimage-patchelf.py");
    expect(debBuild?.env?.CARGO_TARGET_DIR).toContain("opencodex-deb-target");
    expect(appImageBuild?.env?.CARGO_TARGET_DIR).not.toBe(debBuild?.env?.CARGO_TARGET_DIR);
    const stage = shell?.steps?.find(step => step.name === "Stage isolated Linux bundles");
    expect(stage?.run).toContain("$APPIMAGE_BUNDLE/.");
    expect(stage?.run).toContain("$DEB_BUNDLE/.");
    expect(stage?.run).toContain('chmod -R a-w "$BUNDLE_ROOT"');

    const aggregate = workflow.jobs?.ci?.steps?.find(step => step.name === "Assert every job this event requested succeeded");
    expect(aggregate?.env?.CHANGES_DESKTOP).toBe("${{ needs.changes.outputs.desktop }}");
    expect(aggregate?.run).toContain("desktop-shell) echo \"$desktop_shell\"");

    const e2e = shell?.steps?.find(step => step.name === "Run Linux packaged-shell E2E");
    expect(e2e?.if).toBe("needs.changes.outputs.desktop == 'true'");
    expect(e2e?.run).toContain("dbus-run-session -- xvfb-run");
    expect(e2e?.run).toContain("openbox");
    expect(e2e?.run).toContain("linux-packaged-e2e.ts");
    expect(e2e?.run).toContain("opencodex-linux-bundles");
    expect(e2e?.run).not.toContain("sudo");
    expect(e2e?.run).not.toContain("dpkg -i");
    const deps = shell?.steps?.find(step => step.name === "Install Tauri Linux dependencies");
    expect(deps?.run).toContain("wmctrl");

    const upload = shell?.steps?.find(step => step.name === "Upload Linux packaged-shell E2E report");
    expect(upload?.uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/u);
    expect(upload?.if).toContain("always()");
  });
});
