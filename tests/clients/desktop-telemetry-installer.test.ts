import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  renderTelemetryInstallerFragment,
  TELEMETRY_INSTALLER_CHECKBOX_PROPERTY,
  TELEMETRY_INSTALLER_CHECKBOX_TEXT,
  TELEMETRY_INSTALLER_CHOICE_PROPERTY,
  TELEMETRY_INSTALLER_COMPONENT_GROUP,
  TELEMETRY_INSTALLER_DIALOG,
  TELEMETRY_INSTALLER_FRAGMENT_PATH,
  TELEMETRY_INSTALLER_KEEP_NOTE,
  TELEMETRY_INSTALLER_OPT_OUT,
  TELEMETRY_INSTALLER_REGISTRY_KEY,
  TELEMETRY_INSTALLER_REGISTRY_VALUE,
  TELEMETRY_INSTALLER_SEND,
} from "../../desktop/scripts/telemetry-installer-dialog";
import { TELEMETRY_CLI_DISCLOSURE_LINES } from "../../src/cli/telemetry";
import { resolveTelemetryStatus } from "../../src/telemetry/consent";
import {
  TELEMETRY_DISCLOSURE_HEADING,
  TELEMETRY_DISCLOSURE_POINTS,
  TELEMETRY_POLICY_URL,
} from "../../src/telemetry/disclosure";
import { readTelemetryState, runTelemetryTick, withPendingTelemetryDecision } from "../../src/telemetry/scheduler";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";

/**
 * SignPath Foundation's conditions: software that sends usage data must describe it in a privacy
 * policy, display that policy during installation, and include an installation option to disable
 * it. The MSI shows the disclosure from the same source the CLI prompt prints, links the policy,
 * and records an unchecked "Send anonymous usage statistics" box as an opt-out that the desktop
 * app saves into the user's config before any proxy can run.
 */
const FRAGMENT = repoPath("desktop", "src-tauri", TELEMETRY_INSTALLER_FRAGMENT_PATH);
const RUST = repoPath("desktop", "src-tauri", "src", "installer_telemetry.rs");

function rustCode(path: string): string {
  return readFileSync(path, "utf8").replace(/\/\/[^\n]*/g, "");
}

function rustConst(name: string): string {
  const match = new RegExp(`pub const ${name}: &str = r?"([^"]*)";`).exec(readFileSync(RUST, "utf8"));
  if (!match) throw new Error(`installer_telemetry.rs lost ${name}`);
  return match[1]!;
}

function xmlUnescape(value: string): string {
  return value.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

describe("Windows installer telemetry choice", () => {
  const wxs = readFileSync(FRAGMENT, "utf8");

  test("the committed fragment is generated from the shared disclosure source", () => {
    expect(wxs).toBe(renderTelemetryInstallerFragment());
    const shown = [...wxs.matchAll(/<Control Id="Point\d+" Type="Text"[^>]* Text="([^"]*)"/g)].map(match => xmlUnescape(match[1]!));
    expect(shown).toEqual(TELEMETRY_DISCLOSURE_POINTS.map(point => `• ${point}`));
    expect(wxs).toContain(`Text="${TELEMETRY_DISCLOSURE_HEADING}"`);
    // The CLI prompt prints the same text, so the two disclosures cannot drift apart.
    expect(TELEMETRY_CLI_DISCLOSURE_LINES).toEqual([
      `  ${TELEMETRY_DISCLOSURE_HEADING}`,
      ...TELEMETRY_DISCLOSURE_POINTS.map(point => `  • ${point}`),
    ]);
  });

  test("the dialog links the policy and offers a disable option that is checked by default", () => {
    expect(wxs).toContain(`<a href="${TELEMETRY_POLICY_URL}">Read the full privacy policy</a>`);
    expect(wxs).toContain(`<Property Id="${TELEMETRY_INSTALLER_CHECKBOX_PROPERTY}" Value="1" Secure="yes" />`);
    expect(wxs).toMatch(new RegExp(`Type="CheckBox"[^>]*Property="${TELEMETRY_INSTALLER_CHECKBOX_PROPERTY}" CheckBoxValue="1" Text="${TELEMETRY_INSTALLER_CHECKBOX_TEXT}"`));
    // A checked box writes "send", which is never acted on, and the page says so.
    expect(wxs).toContain(`Text="${TELEMETRY_INSTALLER_KEEP_NOTE}"`);
    // Unchecking records an opt-out; silent installs default to send and opt out with the property.
    expect(wxs).toContain(`<Property Id="${TELEMETRY_INSTALLER_CHOICE_PROPERTY}" Value="${TELEMETRY_INSTALLER_SEND}" Secure="yes" />`);
    expect(wxs).toContain(
      `<Publish Property="${TELEMETRY_INSTALLER_CHOICE_PROPERTY}" Value="${TELEMETRY_INSTALLER_OPT_OUT}">NOT (${TELEMETRY_INSTALLER_CHECKBOX_PROPERTY} = "1")</Publish>`,
    );
    expect(wxs).toContain(
      `<RegistryValue Root="HKCU" Key="${TELEMETRY_INSTALLER_REGISTRY_KEY}" Name="${TELEMETRY_INSTALLER_REGISTRY_VALUE}" Type="string" Value="[${TELEMETRY_INSTALLER_CHOICE_PROPERTY}]" KeyPath="yes" />`,
    );
  });

  test("the dialog sits between the welcome and install-directory pages of Tauri's sequence", () => {
    // Tauri's main.wxs routes WelcomeDlg -> InstallDirDlg at Order 2; the later NewDialog wins.
    expect(wxs).toContain(`<Publish Dialog="WelcomeDlg" Control="Next" Event="NewDialog" Value="${TELEMETRY_INSTALLER_DIALOG}" Order="3">1</Publish>`);
    expect(wxs).toContain(`<Publish Dialog="InstallDirDlg" Control="Back" Event="NewDialog" Value="${TELEMETRY_INSTALLER_DIALOG}" Order="3">1</Publish>`);
    const dialog = /<Dialog Id="OcxTelemetryDlg"[\s\S]*?<\/Dialog>/.exec(wxs)?.[0] ?? "";
    expect(dialog).toMatch(/<Control Id="Back"[\s\S]*?Value="WelcomeDlg"/);
    expect(dialog).toMatch(/<Control Id="Next"[\s\S]*?Event="NewDialog" Value="InstallDirDlg"/);
  });

  test("the Tauri config links the fragment and the app reads the same registry value", () => {
    const config = JSON.parse(readFileSync(repoPath("desktop", "src-tauri", "tauri.conf.json"), "utf8"));
    expect(config.bundle.windows.wix.fragmentPaths).toEqual([TELEMETRY_INSTALLER_FRAGMENT_PATH]);
    expect(config.bundle.windows.wix.componentGroupRefs).toEqual([TELEMETRY_INSTALLER_COMPONENT_GROUP]);
    expect(wxs).toContain(`<ComponentGroup Id="${TELEMETRY_INSTALLER_COMPONENT_GROUP}">`);
    expect(rustConst("REGISTRY_KEY")).toBe(TELEMETRY_INSTALLER_REGISTRY_KEY);
    expect(rustConst("REGISTRY_VALUE")).toBe(TELEMETRY_INSTALLER_REGISTRY_VALUE);
    expect(rustConst("OPT_OUT")).toBe(TELEMETRY_INSTALLER_OPT_OUT);
  });

  test("the app saves the opt-out before it resolves or starts a proxy, and falls back to the env opt-out", () => {
    const startup = rustCode(repoPath("desktop", "src-tauri", "src", "startup.rs"));
    const run = startup.slice(startup.indexOf("async fn run(app: &AppHandle, started: Instant)"));
    const applyAt = run.indexOf("crate::installer_telemetry::apply(app, deadline).await");
    expect(applyAt).toBeGreaterThan(0);
    expect(applyAt).toBeLessThan(run.indexOf("resolve::run(app, deadline)"));
    expect(applyAt).toBeLessThan(run.indexOf("spawn_runtime("));
    const sidecar = rustCode(repoPath("desktop", "src-tauri", "src", "sidecar.rs"));
    expect(sidecar).toMatch(/if crate::installer_telemetry::sidecar_env_opt_out\(\) \{\s*command = command\.env\("OCX_TELEMETRY", "0"\);/);
    const module = rustCode(RUST);
    expect(module).toContain(`.args(["telemetry", "disable", "--json"])`);
    // A failed save is retried in the background, so a proxy the app only attaches to follows it too.
    expect(module).toMatch(/Outcome::NotPersisted => \{[\s\S]*?tauri::async_runtime::spawn\(async move \{ retry\(app\)\.await \}\)/);
  });

  test("the command the app runs persists the opt-out, and nothing is sent afterwards", async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-installer-optout-"));
    try {
      const env: Record<string, string> = {
        HOME: join(home, "home"),
        USERPROFILE: join(home, "home"),
        OPENCODEX_HOME: join(home, "ocx"),
        PATH: process.env.PATH ?? "",
      };
      const result = Bun.spawnSync([process.execPath, repoPath("src", "cli", "index.ts"), "telemetry", "disable", "--json"], {
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
      // On a fresh install the decline is held without creating config.json, so `ocx init` still runs setup.
      expect(existsSync(join(home, "ocx", "config.json"))).toBe(false);
      expect(readTelemetryState(join(home, "ocx")).pendingDecision?.decision).toBe("declined");
      expect(resolveTelemetryStatus(withPendingTelemetryDecision({}, join(home, "ocx")), {}).effective).toBe(false);

      let fetchCalls = 0;
      const tick = await runTelemetryTick({
        configDir: join(home, "ocx"),
        readConfig: () => ({}),
        env: {},
        now: Date.parse("2026-11-12T12:00:00.000Z"),
        fetch: (async () => {
          fetchCalls += 1;
          return new Response("{}", { status: 202 });
        }) as unknown as typeof fetch,
      });
      expect(tick.sent).toBe(false);
      expect(fetchCalls).toBe(0);
    } finally {
      removeTreeWithRetry(home);
    }
  });
});
