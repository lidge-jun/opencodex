import { describe, expect, test } from "bun:test";

const root = new URL("../", import.meta.url);

async function readText(path: string): Promise<string> {
  return await Bun.file(new URL(path, root)).text();
}

function count(text: string, fragment: string): number {
  return text.split(fragment).length - 1;
}

describe("GitHub Actions hardening", () => {
  test("cross-platform CI keeps bounded jobs and immutable action references", async () => {
    const workflow = await readText(".github/workflows/ci.yml");

    expect(count(workflow, "timeout-minutes: 8")).toBe(2);
    expect(workflow).toContain("actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0");
    expect(workflow).toContain("oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6");
    expect(workflow).toContain("actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020");
    expect(workflow).not.toMatch(/uses:\s+\S+@(?:v\d+|main|master)\b/);
  });

  test("service lifecycle is least-privilege, bounded, and cannot swallow health failures", async () => {
    const workflow = await readText(".github/workflows/service-lifecycle.yml");

    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain("group: service-lifecycle-${{ github.ref }}");
    expect(workflow).toContain("cancel-in-progress: true");
    expect(count(workflow, "timeout-minutes: 10")).toBe(3);
    expect(count(workflow, "if: ${{ !cancelled() }}")).toBe(3);
    expect(workflow).not.toContain("always()");
    expect(workflow).not.toContain('healthz || echo "healthz not ready yet"');
    expect(workflow).not.toContain("sleep 8");
    expect(workflow).toContain("systemd service has no positive MainPID before crash test");
    expect(workflow).toContain("Get-ScheduledTask -TaskName opencodex-proxy -ErrorAction SilentlyContinue");
    expect(workflow).toContain("launchd artifact or proxy survived uninstall");
    expect(workflow).toContain("scheduled task or proxy survived uninstall");
    expect(workflow).not.toMatch(/uses:\s+\S+@(?:v\d+|main|master)\b/);
  });
});
