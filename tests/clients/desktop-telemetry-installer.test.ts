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
  TELEMETRY_INSTALLER_STAMP_PROPERTY,
  TELEMETRY_INSTALLER_STAMP_VALUE,
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

type Props = Record<string, string>;

/** Evaluates the subset of Windows Installer condition syntax the fragment uses. */
function msiCondition(condition: string, props: Props): boolean {
  const tokens = xmlUnescape(condition).match(/"[^"]*"|~<>|~=|<>|=|\(|\)|[A-Za-z_][A-Za-z0-9_.]*|\d+/g) ?? [];
  let at = 0;
  const peek = () => tokens[at];
  const value = (token: string): string => (token.startsWith('"') ? token.slice(1, -1) : /^\d+$/.test(token) ? token : props[token] ?? "");
  const primary = (): boolean => {
    const token = tokens[at++];
    if (token === undefined) throw new Error(`incomplete condition: ${condition}`);
    if (token === "NOT") return !primary();
    if (token === "(") {
      const inner = or();
      if (tokens[at++] !== ")") throw new Error(`unbalanced condition: ${condition}`);
      return inner;
    }
    const op = peek();
    if (op === "=" || op === "<>" || op === "~=" || op === "~<>") {
      at += 1;
      let left = value(token);
      let right = value(tokens[at++]!);
      if (op.startsWith("~")) [left, right] = [left.toLowerCase(), right.toLowerCase()];
      return op.endsWith("<>") ? left !== right : left === right;
    }
    const bare = value(token);
    return bare !== "" && bare !== "0";
  };
  const and = (): boolean => {
    let result = primary();
    while (peek() === "AND") { at += 1; result = primary() && result; }
    return result;
  };
  const or = (): boolean => {
    let result = and();
    while (peek() === "OR") { at += 1; result = and() || result; }
    return result;
  };
  const result = or();
  if (at !== tokens.length) throw new Error(`unparsed condition: ${condition}`);
  return result;
}

function msiFormat(template: string, props: Props, clock: string): string {
  return template.replace(/\[([A-Za-z_]+)\]/g, (_, name: string) => (name === "Date" ? clock.split(" ")[0]! : name === "Time" ? clock.split(" ")[1]! : props[name] ?? ""));
}

interface InstallRun {
  /** HKLM values an earlier install left, read by AppSearch. */
  previous?: { choice: string; stamp: string };
  /** Public properties on the msiexec command line. */
  commandLine?: Props;
  /** `full` shows the page; `reduced` (/qr) runs the UI sequence without dialogs; `none` (/qn, /qb, /passive) skips it. */
  ui: "full" | "reduced" | "none";
  /** In a full-UI run: the box state the person leaves before clicking Next (default: as preselected). */
  box?: boolean;
  /** In a full-UI run: the box state at each Next click, with Back in between (overrides `box`). */
  clicks?: boolean[];
}

/**
 * Runs the fragment's SetProperty actions and the page's Next publishes through both MSI phases and
 * returns what the component writes to HKLM. The UI phase is stamped "11/8/2026 01:00:00", the
 * install phase "11/8/2026 02:00:00", so a re-stamp in the install phase shows.
 */
function simulateInstall(wxs: string, run: InstallRun): { choice: string; stamp: string; boxPreselected?: boolean } {
  const actions = [...wxs.matchAll(/<SetProperty Action="(\w+)" Id="(\w+)" Value="([^"]*)" (?:Before|After)="\w+" Sequence="(\w+)">([^<]*)<\/SetProperty>/g)]
    .map(([, action, id, template, sequence, condition]) => ({ action: action!, id: id!, template: template!, sequence: sequence!, condition: condition! }));
  if (actions.length !== 7) throw new Error(`expected 7 SetProperty actions, found ${actions.length}`);
  const secure = [...wxs.matchAll(/<Property Id="(\w+)" Secure="yes" \/>/g)].map(match => match[1]!);
  const phase = (props: Props, sequence: "ui" | "execute", clock: string): Props => {
    for (const step of actions) {
      if (step.sequence !== "both" && step.sequence !== sequence) continue;
      if (step.action === "OcxTelemetryKeepChoice" && run.previous) {
        // AppSearch runs between OcxTelemetryStampExplicit and OcxTelemetryKeepChoice.
        props.OCX_TELEMETRY_PREVIOUS_CHOICE = run.previous.choice;
        props.OCX_TELEMETRY_PREVIOUS_STAMP = run.previous.stamp;
      }
      if (msiCondition(step.condition, props)) props[step.id] = msiFormat(step.template, props, clock);
    }
    return props;
  };
  const commandLine = run.commandLine ?? {};
  let boxPreselected: boolean | undefined;
  let carried: Props = {};
  if (run.ui !== "none") {
    const ui = phase({ ...commandLine }, "ui", "11/8/2026 01:00:00");
    if (run.ui === "full") {
      boxPreselected = ui.OCX_TELEMETRY_SEND === "1";
      const next = /<Control Id="Next"[\s\S]*?<\/Control>/.exec(wxs)?.[0] ?? "";
      // Each Next click (Back from the next page returns here) has its own time.
      const clicks = run.clicks ?? [run.box ?? boxPreselected];
      for (const [index, box] of clicks.entries()) {
        if (box) ui.OCX_TELEMETRY_SEND = "1";
        else delete ui.OCX_TELEMETRY_SEND;
        const clock = index === 0 ? "11/8/2026 01:00:00" : `11/8/2026 01:0${index}:00`;
        for (const [, property, template, condition] of next.matchAll(/<Publish Property="(\w+)" Value="([^"]*)">([^<]*)<\/Publish>/g)) {
          if (msiCondition(condition!, ui)) ui[property!] = msiFormat(template!, ui, clock);
        }
      }
    }
    // Only Secure public properties reach the elevated install phase.
    carried = Object.fromEntries(secure.filter(name => ui[name] !== undefined).map(name => [name, ui[name]!]));
  }
  const execute = phase({ ...commandLine, ...carried }, "execute", "11/8/2026 02:00:00");
  return { choice: execute.OCX_TELEMETRY_CHOICE ?? "", stamp: execute.OCX_TELEMETRY_STAMP ?? "", boxPreselected };
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
    expect(wxs).toMatch(new RegExp(`Type="CheckBox"[^>]*Property="${TELEMETRY_INSTALLER_CHECKBOX_PROPERTY}" CheckBoxValue="1" Text="${TELEMETRY_INSTALLER_CHECKBOX_TEXT}"`));
    // The box starts checked only when the choice is send, so any carried opt-out (command line or upgrade) starts unchecked.
    expect(wxs).toContain(
      `<SetProperty Action="OcxTelemetryCheckBox" Id="${TELEMETRY_INSTALLER_CHECKBOX_PROPERTY}" Value="1" After="OcxTelemetryDefaultChoice" Sequence="ui">${TELEMETRY_INSTALLER_CHOICE_PROPERTY} ~= "send"</SetProperty>`,
    );
    // A checked box writes "send", which is never acted on, and the page says so.
    expect(wxs).toContain(`Text="${TELEMETRY_INSTALLER_KEEP_NOTE}"`);
    // Unchecking records an opt-out; a new stamp is issued only when the choice differs from the carried one.
    const next = /<Control Id="Next"[\s\S]*?<\/Control>/.exec(wxs)?.[0] ?? "";
    expect(next).toContain(
      `<Publish Property="${TELEMETRY_INSTALLER_CHOICE_PROPERTY}" Value="${TELEMETRY_INSTALLER_OPT_OUT}">NOT (${TELEMETRY_INSTALLER_CHECKBOX_PROPERTY} = "1")</Publish>`,
    );
    expect(next).toContain(
      `<Publish Property="${TELEMETRY_INSTALLER_STAMP_PROPERTY}" Value="[Date] [Time]">${TELEMETRY_INSTALLER_CHOICE_PROPERTY} ~&lt;&gt; OCX_TELEMETRY_PREVIOUS_CHOICE</Publish>`,
    );
    // The stamp is compared after the choice is set.
    expect(next.indexOf(`Property="${TELEMETRY_INSTALLER_STAMP_PROPERTY}"`)).toBeGreaterThan(next.lastIndexOf(`Property="${TELEMETRY_INSTALLER_CHOICE_PROPERTY}"`));
  });

  test("the choice is machine-wide, survives upgrades, and a silent opt-out gets its own stamp", () => {
    // HKLM, so a silent install run as SYSTEM (Intune, SCCM) reaches every user.
    for (const name of [TELEMETRY_INSTALLER_REGISTRY_VALUE, TELEMETRY_INSTALLER_STAMP_VALUE]) {
      expect(wxs).toMatch(new RegExp(`<RegistryValue Root="HKLM" Key="${TELEMETRY_INSTALLER_REGISTRY_KEY.replaceAll("\\", "\\\\")}" Name="${name}" Type="string"`));
      expect(wxs).toMatch(new RegExp(`<RegistrySearch Id="[^"]+" Root="HKLM" Key="${TELEMETRY_INSTALLER_REGISTRY_KEY.replaceAll("\\", "\\\\")}" Name="${name}" Type="raw"`));
    }
    expect(wxs).not.toContain('Root="HKCU"');
    // No default value: a command-line choice is told apart from an upgrade that carries one.
    expect(wxs).toContain(`<Property Id="${TELEMETRY_INSTALLER_CHOICE_PROPERTY}" Secure="yes" />`);
    const order = ["OcxTelemetryStampExplicit", "OcxTelemetryKeepChoice", "OcxTelemetryKeepStamp", "OcxTelemetryDefaultChoice", "OcxTelemetryCheckBox"]
      .map(action => wxs.indexOf(`Action="${action}"`));
    expect(order.every(index => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(wxs).toContain(`Action="OcxTelemetryStampExplicit" Id="${TELEMETRY_INSTALLER_STAMP_PROPERTY}" Value="[Date] [Time]" Before="AppSearch"`);
    expect(wxs).toContain(`Action="OcxTelemetryKeepChoice" Id="${TELEMETRY_INSTALLER_CHOICE_PROPERTY}" Value="[OCX_TELEMETRY_PREVIOUS_CHOICE]" After="AppSearch"`);
  });

  test("every scheduling parent exists in each sequence its action runs in, as WiX's linker requires", () => {
    // Standard actions present in both InstallUISequence and InstallExecuteSequence.
    const standard = new Set(["AppSearch"]);
    const actions = [...wxs.matchAll(/<SetProperty Action="(\w+)" Id="\w+" Value="[^"]*" (Before|After)="(\w+)" Sequence="(\w+)">/g)]
      .map(([, action, , parent, sequence]) => ({ action: action!, parent: parent!, sequences: sequence === "both" ? ["ui", "execute"] : [sequence!] }));
    expect(actions.length).toBeGreaterThan(0);
    for (const { action, parent, sequences } of actions) {
      for (const sequence of sequences) {
        const parentScheduled = standard.has(parent) || actions.some(other => other.action === parent && other.sequences.includes(sequence));
        expect(parentScheduled, `${action} (${sequence}) is scheduled after ${parent}, which is not in that sequence`).toBe(true);
      }
    }
  });

  test("no condition tests a property bare, since a property holding the integer 0 would read as false", () => {
    const conditions = [
      ...wxs.matchAll(/<SetProperty [^>]*>([^<]*)<\/SetProperty>/g),
      ...wxs.matchAll(/<Publish Property="\w+" Value="[^"]*">([^<]*)<\/Publish>/g),
    ].map(match => xmlUnescape(match[1]!));
    expect(conditions.length).toBeGreaterThan(0);
    for (const condition of conditions) {
      expect(condition, condition).not.toMatch(/(^|\bAND |\bOR |\bNOT |\()\s*OCX_TELEMETRY_\w+\s*($|\)| AND\b| OR\b)/);
    }
  });

  describe("what each kind of install records in HKLM", () => {
    const optOut = TELEMETRY_INSTALLER_OPT_OUT;
    const send = "send";
    const UI_STAMP = "11/8/2026 01:00:00";
    const INSTALL_STAMP = "11/8/2026 02:00:00";

    test("a fresh install with the page records the box, stamped when Next was clicked", () => {
      expect(simulateInstall(wxs, { ui: "full" })).toEqual({ choice: send, stamp: UI_STAMP, boxPreselected: true });
      expect(simulateInstall(wxs, { ui: "full", box: false })).toEqual({ choice: optOut, stamp: UI_STAMP, boxPreselected: true });
    });

    test("a silent opt-out on the command line gets its own stamp, in any letter case", () => {
      expect(simulateInstall(wxs, { ui: "none", commandLine: { OCX_TELEMETRY_CHOICE: optOut } })).toEqual({ choice: optOut, stamp: INSTALL_STAMP, boxPreselected: undefined });
      expect(simulateInstall(wxs, { ui: "reduced", commandLine: { OCX_TELEMETRY_CHOICE: optOut } })).toEqual({ choice: optOut, stamp: UI_STAMP, boxPreselected: undefined });
      // A full-UI install given OptOut starts with the box unchecked, so Next keeps the opt-out.
      expect(simulateInstall(wxs, { ui: "full", commandLine: { OCX_TELEMETRY_CHOICE: "OptOut" } })).toEqual({ choice: optOut, stamp: UI_STAMP, boxPreselected: false });
    });

    test("an upgrade without the page keeps the previous choice and stamp, so nothing is re-applied", () => {
      for (const ui of ["none", "reduced"] as const) {
        for (const previous of [{ choice: optOut, stamp: "s1" }, { choice: send, stamp: "s1" }]) {
          expect(simulateInstall(wxs, { ui, previous }), `${ui} ${previous.choice}`).toEqual({ ...previous, boxPreselected: undefined });
        }
      }
    });

    test("an upgrade never turns a previous opt-out into send unless the person checks the box", () => {
      for (const ui of ["none", "reduced", "full"] as const) {
        expect(simulateInstall(wxs, { ui, previous: { choice: optOut, stamp: "s1" } }).choice, ui).toBe(optOut);
      }
      // The page preselects the previous choice.
      expect(simulateInstall(wxs, { ui: "full", previous: { choice: optOut, stamp: "s1" } }).boxPreselected).toBe(false);
      expect(simulateInstall(wxs, { ui: "full", previous: { choice: send, stamp: "s1" } }).boxPreselected).toBe(true);
      // Checking it records send, which the app never acts on: a saved decline stays declined.
      expect(simulateInstall(wxs, { ui: "full", box: true, previous: { choice: optOut, stamp: "s1" } }).choice).toBe(send);
    });

    test("the page issues a new stamp only when the person changes the carried choice", () => {
      // Continuing past a carried opt-out keeps its stamp, so the app does not apply it again over a
      // dashboard enable made since.
      expect(simulateInstall(wxs, { ui: "full", previous: { choice: optOut, stamp: "s1" } })).toEqual({ choice: optOut, stamp: "s1", boxPreselected: false });
      expect(simulateInstall(wxs, { ui: "full", previous: { choice: "OptOut", stamp: "s1" } })).toEqual({ choice: optOut, stamp: "s1", boxPreselected: false });
      expect(simulateInstall(wxs, { ui: "full", previous: { choice: send, stamp: "s1" } })).toEqual({ choice: send, stamp: "s1", boxPreselected: true });
      // A change is a new decision.
      expect(simulateInstall(wxs, { ui: "full", box: false, previous: { choice: send, stamp: "s1" } })).toEqual({ choice: optOut, stamp: UI_STAMP, boxPreselected: true });
      expect(simulateInstall(wxs, { ui: "full", box: true, previous: { choice: optOut, stamp: "s1" } })).toEqual({ choice: send, stamp: UI_STAMP, boxPreselected: false });
    });

    test("a silent install without a choice defaults to send and records no stamp", () => {
      expect(simulateInstall(wxs, { ui: "none" })).toEqual({ choice: send, stamp: "", boxPreselected: undefined });
    });

    test("going Back and putting the box back keeps the carried stamp", () => {
      // Checked, Next, Back, unchecked again, Next: the final choice equals the carried one.
      expect(simulateInstall(wxs, { ui: "full", clicks: [true, false], previous: { choice: optOut, stamp: "s1" } })).toEqual({ choice: optOut, stamp: "s1", boxPreselected: false });
      expect(simulateInstall(wxs, { ui: "full", clicks: [false, true], previous: { choice: send, stamp: "s1" } })).toEqual({ choice: send, stamp: "s1", boxPreselected: true });
      // A real change is still a new decision, stamped at the Next that made it.
      expect(simulateInstall(wxs, { ui: "full", clicks: [true, false, true], previous: { choice: optOut, stamp: "s1" } })).toEqual({ choice: send, stamp: "11/8/2026 01:02:00", boxPreselected: false });
      // A command-line opt-out keeps its own new stamp when the person leaves it as it is.
      expect(simulateInstall(wxs, { ui: "full", clicks: [true, false], commandLine: { OCX_TELEMETRY_CHOICE: optOut }, previous: { choice: optOut, stamp: "s1" } })).toEqual({ choice: optOut, stamp: UI_STAMP, boxPreselected: false });
    });

    test("any command-line value other than send counts as an opt-out", () => {
      for (const value of ["off", "0", "opt-out", "disabled", " optout", "OPTOUT", " send"]) {
        expect(simulateInstall(wxs, { ui: "none", commandLine: { OCX_TELEMETRY_CHOICE: value } }), value).toEqual({ choice: optOut, stamp: INSTALL_STAMP, boxPreselected: undefined });
        expect(simulateInstall(wxs, { ui: "full", commandLine: { OCX_TELEMETRY_CHOICE: value } }).boxPreselected, value).toBe(false);
      }
      expect(simulateInstall(wxs, { ui: "none", commandLine: { OCX_TELEMETRY_CHOICE: "Send" } }).choice).toBe("Send");
    });

    test("a carried value other than send also preselects an unchecked box", () => {
      // Written by something other than this MSI (a policy pre-seed): the app already reads it as an opt-out.
      expect(simulateInstall(wxs, { ui: "full", previous: { choice: "off", stamp: "s1" } })).toEqual({ choice: optOut, stamp: UI_STAMP, boxPreselected: false });
      expect(simulateInstall(wxs, { ui: "none", previous: { choice: "off", stamp: "s1" } })).toEqual({ choice: "off", stamp: "s1", boxPreselected: undefined });
      expect(simulateInstall(wxs, { ui: "full", previous: { choice: "SEND", stamp: "s1" } }).boxPreselected).toBe(true);
      // A carried integer 0 is a value: a bare property test would read it as false and fall back to send.
      expect(simulateInstall(wxs, { ui: "full", previous: { choice: "0", stamp: "s1" } })).toEqual({ choice: optOut, stamp: UI_STAMP, boxPreselected: false });
      expect(simulateInstall(wxs, { ui: "none", previous: { choice: "0", stamp: "s1" } })).toEqual({ choice: "0", stamp: "s1", boxPreselected: undefined });
    });
  });

  test("the dialog sits between the welcome and install-directory pages of Tauri's sequence", () => {
    // Tauri's main.wxs routes WelcomeDlg -> InstallDirDlg at Order 2; the later NewDialog wins.
    // Only on a first install, so an installed product's patch route (WelcomeDlg -> VerifyReadyDlg) is untouched.
    expect(wxs).toContain(`<Publish Dialog="WelcomeDlg" Control="Next" Event="NewDialog" Value="${TELEMETRY_INSTALLER_DIALOG}" Order="3">NOT Installed</Publish>`);
    expect(wxs).toContain(`<Publish Dialog="InstallDirDlg" Control="Back" Event="NewDialog" Value="${TELEMETRY_INSTALLER_DIALOG}" Order="3">NOT Installed</Publish>`);
    expect(msiCondition("NOT Installed", {})).toBe(true);
    expect(msiCondition("NOT Installed", { Installed: "00:00:00" })).toBe(false);
    const dialog = /<Dialog Id="OcxTelemetryDlg"[\s\S]*?<\/Dialog>/.exec(wxs)?.[0] ?? "";
    expect(dialog).toMatch(/<Control Id="Back"[\s\S]*?Value="WelcomeDlg"/);
    expect(dialog).toMatch(/<Control Id="Next"[\s\S]*?Event="NewDialog" Value="InstallDirDlg"/);
    // Tauri routes through LicenseAgreementDlg only when a license file is set; the page's Next goes
    // straight to InstallDirDlg, so a license file would need the page rerouted first.
    const tauri = JSON.parse(readFileSync(repoPath("desktop", "src-tauri", "tauri.conf.json"), "utf8"));
    expect(tauri.bundle.licenseFile).toBeUndefined();
    expect(tauri.bundle.windows?.wix?.license).toBeUndefined();
  });

  test("the Tauri config links the fragment and the app reads the same registry values", () => {
    const config = JSON.parse(readFileSync(repoPath("desktop", "src-tauri", "tauri.conf.json"), "utf8"));
    expect(config.bundle.windows.wix.fragmentPaths).toEqual([TELEMETRY_INSTALLER_FRAGMENT_PATH]);
    expect(config.bundle.windows.wix.componentGroupRefs).toEqual([TELEMETRY_INSTALLER_COMPONENT_GROUP]);
    expect(wxs).toContain(`<ComponentGroup Id="${TELEMETRY_INSTALLER_COMPONENT_GROUP}">`);
    expect(rustConst("REGISTRY_KEY")).toBe(TELEMETRY_INSTALLER_REGISTRY_KEY);
    expect(rustConst("REGISTRY_VALUE")).toBe(TELEMETRY_INSTALLER_REGISTRY_VALUE);
    expect(rustConst("STAMP_VALUE")).toBe(TELEMETRY_INSTALLER_STAMP_VALUE);
    expect(rustConst("OPT_OUT")).toBe(TELEMETRY_INSTALLER_OPT_OUT);
    // The app reads the machine-wide choice and a per-user one, and records each applied stamp under HKCU.
    const module = rustCode(RUST);
    expect(module).toContain("RegKey::predef(HKEY_LOCAL_MACHINE)");
    expect(module).toMatch(/RegKey::predef\(HKEY_CURRENT_USER\)[\s\S]*?read\(&key, Scope::User\)/);
    expect(module).toContain("create_subkey(super::REGISTRY_KEY)");
    expect(rustConst("APPLIED_STAMP_VALUE")).toBe("AppliedInstallerStamp");
    expect(rustConst("APPLIED_USER_STAMP_VALUE")).toBe("AppliedUserInstallerStamp");
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
    expect(module).toMatch(/Outcome::NotPersisted => \{[\s\S]*?tauri::async_runtime::spawn\(async move \{ retry\(app, pending\)\.await \}\)/);
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
