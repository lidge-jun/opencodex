import { describe, expect, test } from "bun:test";

const root = new URL("../", import.meta.url);

async function readText(path: string): Promise<string> {
  return await Bun.file(new URL(path, root)).text();
}

describe("full uninstall command", () => {
  test("CLI exposes a one-shot local state cleanup command", async () => {
    const cli = await readText("src/cli/index.ts");

    expect(cli).toContain('case "uninstall"');
    expect(cli).toContain("async function handleUninstall()");
    expect(cli).toContain("uninstallServiceIfInstalled");
    expect(cli).toContain("uninstallCodexShim");
    expect(cli).toContain("restoreNativeCodex");
    expect(cli).toContain("rmSync(getConfigDir()");
  });

  test("CLI exposes explicit legacy history recovery command", async () => {
    const cli = await readText("src/cli/index.ts");

    expect(cli).toContain("ocx recover-history --legacy-openai");
    expect(cli).toContain("function handleRecoverHistory()");
    expect(cli).toContain("restoreLegacyOpenaiHistory");
  });

  test("service cleanup has a quiet best-effort helper", async () => {
    const service = await readText("src/service.ts");

    expect(service).toContain("export function uninstallServiceIfInstalled()");
    expect(service).toContain("uninstallLaunchd");
    expect(service).toContain("uninstallWindows");
    expect(service).toContain("uninstallSystemd");
  });

  test("full uninstall kills the tracked proxy before deleting service assets", async () => {
    const cli = await readText("src/cli/index.ts");
    const uninstallBody = cli.slice(cli.indexOf("async function handleUninstall()"), cli.indexOf("type HealthCheck"));

    expect(uninstallBody).toContain('runStep("service stopped"');
    expect(uninstallBody).toContain('runStep("proxy stopped"');
    expect(uninstallBody).toContain('runStep("service removed"');
    expect(uninstallBody).toContain("await stopProxy(pid);");
    expect(uninstallBody).toContain("uninstallServiceIfInstalled()");
    expect(uninstallBody.indexOf('runStep("service stopped"')).toBeLessThan(uninstallBody.indexOf('runStep("proxy stopped"'));
    expect(uninstallBody.indexOf('runStep("proxy stopped"')).toBeLessThan(uninstallBody.indexOf('runStep("service removed"'));
    expect(uninstallBody.indexOf("await stopProxy(pid);")).toBeLessThan(uninstallBody.indexOf("uninstallServiceIfInstalled()"));
  });
});
