import { readFileSync } from "node:fs";
import { TASK, windowsServiceScriptPath, windowsLauncherVbsPath, windowsTaskXmlPath } from "./state";
import { windowsWscript } from "./windows-scheduler";
import { join } from "node:path";
import { BUN_RUNTIME_PATH_ENV, BUN_RUNTIME_SOURCE_ENV } from "../lib/bun-runtime";
import { serviceApiTokenFilePath } from "../lib/service-secrets";
import { windowsEnvIndirectBatchPathList, windowsEnvIndirectBatchValue } from "../lib/win-paths";
import { cachedCurrentWindowsIdentity, resolveCurrentWindowsPrincipal, WINDOWS_PRINCIPAL_LOOKUP_TIMEOUT_MS } from "../lib/windows-user-principal";
import { resolveServiceListenPort, resolvedProxyEnv } from "./health";
import { cliEntry, serviceLogPath, currentCodexSqliteHomeAbsolute } from "./state";

function windowsBatchValue(value: string): string {
  return value
    .replace(/%/g, "%%")
    .replace(/\^/g, "^^")
    .replace(/"/g, "")
    .replace(/[\r\n]/g, "");
}

type WindowsBatchValueKind = "raw" | "path" | "pathList";

function windowsBatchSet(name: string, value: string | undefined, kind: WindowsBatchValueKind = "raw"): string | null {
  if (!value) return null;
  const rendered =
    kind === "path" ? windowsEnvIndirectBatchValue(value, windowsBatchValue)
    : kind === "pathList" ? windowsEnvIndirectBatchPathList(value, windowsBatchValue)
    : windowsBatchValue(value);
  return `set "${name}=${rendered}"`;
}

function taskXmlString(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * RunLevel check. Schema default is LeastPrivilege (omitted on export). Elevated
 * `schtasks /create` often rewrites the registered task to HighestAvailable even when
 * the source XML asked for LeastPrivilege — still InteractiveToken / same user.
 * Keep accepting HighestAvailable here: rejecting it would false-fail healthy elevated
 * installs, and windowsTaskRegistrationHealthy tests encode that contract.
 */
function taskXmlRunLevelAcceptable(principal: string): boolean {
  if (taskXmlHasPrefixedTag(principal, "RunLevel")) return false;
  const count = taskXmlElementCount(principal, "RunLevel");
  if (count === 0) return true;
  if (count > 1) return false;
  const value = new RegExp(`<RunLevel(?:\\s[^>]*?)?>\\s*([^<]*?)\\s*<\\/RunLevel>`, "i").exec(principal)?.[1]?.trim().toLowerCase();
  return value === "leastprivilege" || value === "highestavailable";
}

export function buildWindowsServiceScript(
  entry = cliEntry(),
  port = resolveServiceListenPort(),
  proxyEnv: { name: string; value: string }[] = resolvedProxyEnv(),
): string {
  // Provenance rides along with the entry: a second durableBunRuntime() call here could
  // resolve differently from the binary the caller actually baked.
  const { bun, bunRuntimeSource, cli } = entry;
  const path = process.env.PATH ?? "";
  const lines = [
    "@echo off",
    "setlocal",
    // The wrapper console is hidden by the wscript launcher (window style 0), so switching
    // it to UTF-8 is safe (no leak into user shells) and lets cmd parse UTF-8 remnants.
    "chcp 65001 >nul",
    windowsBatchSet("OCX_SERVICE", "1"),
    windowsBatchSet(BUN_RUNTIME_SOURCE_ENV, bunRuntimeSource),
    windowsBatchSet(BUN_RUNTIME_PATH_ENV, bun, "path"),
    windowsBatchSet("PATH", path, "pathList"),
    windowsBatchSet("CODEX_HOME", process.env.CODEX_HOME?.trim(), "path"),
    windowsBatchSet("CODEX_SQLITE_HOME", currentCodexSqliteHomeAbsolute("windows"), "path"),
    windowsBatchSet("OPENCODEX_HOME", process.env.OPENCODEX_HOME?.trim(), "path"),
    ...proxyEnv.map(({ name, value }) => windowsBatchSet(name, value)),
    windowsBatchSet("OCX_API_TOKEN_FILE", serviceApiTokenFilePath(), "path"),
    windowsBatchSet("OCX_SERVICE_LOG", serviceLogPath(), "path"),
    windowsBatchSet("OCX_BUN", bun, "path"),
    windowsBatchSet("OCX_CLI", cli, "path"),
    // Package root for the transactional-update restore path (#1942): cli is
    // <pkg>\src\cli\index.ts, so the package dir is three levels up.
    'for %%I in ("%OCX_CLI%\\..\\..\\..") do set "OCX_PKG_DIR=%%~fI"',
    'if exist "%OCX_API_TOKEN_FILE%" (',
    '  set /p OPENCODEX_API_AUTH_TOKEN=<"%OCX_API_TOKEN_FILE%"',
    ")",
    ":loop",
    '>>"%OCX_SERVICE_LOG%" echo [%DATE% %TIME%] opencodex service wrapper start',
    '>>"%OCX_SERVICE_LOG%" echo bun="%OCX_BUN%"',
    `>>"%OCX_SERVICE_LOG%" echo bun_source="${bunRuntimeSource}"`,
    '>>"%OCX_SERVICE_LOG%" echo cli="%OCX_CLI%"',
    '>>"%OCX_SERVICE_LOG%" echo opencodex_home="%OPENCODEX_HOME%"',
    '>>"%OCX_SERVICE_LOG%" echo codex_home="%CODEX_HOME%"',
    '>>"%OCX_SERVICE_LOG%" echo token_file="%OCX_API_TOKEN_FILE%"',
    'if not exist "%OCX_BUN%" (',
    "  call :restore_backup",
    ")",
    'if not exist "%OCX_BUN%" (',
    '  >>"%OCX_SERVICE_LOG%" echo [%DATE% %TIME%] installation is incomplete: bundled Bun is missing; reinstall opencodex, then run ocx service repair',
    "  exit /b 3",
    ")",
    'if not exist "%OCX_CLI%" (',
    "  call :restore_backup",
    ")",
    'if not exist "%OCX_CLI%" (',
    '  >>"%OCX_SERVICE_LOG%" echo [%DATE% %TIME%] installation is incomplete: CLI entry is missing; reinstall opencodex, then run ocx service repair',
    "  exit /b 3",
    ")",
    `"%OCX_BUN%" "%OCX_CLI%" start --port ${port} >>"%OCX_SERVICE_LOG%" 2>&1`,
    "if %ERRORLEVEL% NEQ 0 (",
    '  >>"%OCX_SERVICE_LOG%" echo [%DATE% %TIME%] child exited with code %ERRORLEVEL%; restarting in 5s',
    // `timeout` needs console stdin and dies with "Input redirection is not supported"
    // under Task Scheduler, turning the 5s cooldown into a hot restart loop; ping doesn't.
    "  ping -n 6 127.0.0.1 >nul",
    "  goto loop",
    ")",
    "endlocal",
    "goto :eof",
    "",
    // #1942/#1849: a power loss mid-swap leaves the live package dir missing/broken and
    // a sibling .ocx-backup-* holding the previous version. This wrapper lives OUTSIDE
    // the package tree, so it can restore when the launcher itself is gone — the exact
    // window the in-launcher boot probe cannot reach.
    ":restore_backup",
    '>>"%OCX_SERVICE_LOG%" echo [%DATE% %TIME%] install incomplete - looking for a transactional-update backup to restore',
    'for /f "delims=" %%B in (\'dir /b /ad /o-n "%OCX_PKG_DIR%\\..\\.ocx-backup-*" 2^>nul\') do (',
    '  if exist "%OCX_PKG_DIR%\\..\\%%B\\opencodex\\package.json" (',
    '    if exist "%OCX_PKG_DIR%" rmdir /s /q "%OCX_PKG_DIR%" 2>nul',
    '    move "%OCX_PKG_DIR%\\..\\%%B\\opencodex" "%OCX_PKG_DIR%" >nul 2>&1',
    '    if exist "%OCX_PKG_DIR%\\package.json" (',
    '      >>"%OCX_SERVICE_LOG%" echo [%DATE% %TIME%] restored previous install from %%B',
    "      goto :eof",
    "    )",
    "  )",
    ")",
    '>>"%OCX_SERVICE_LOG%" echo [%DATE% %TIME%] no restorable backup found',
    "goto :eof",
  ].filter((line): line is string => Boolean(line));
  return `${lines.join("\r\n")}\r\n`;
}

export function buildWindowsSchtasksCreateArgs(script = windowsServiceScriptPath()): string[] {
  const xml = script === windowsServiceScriptPath() ? windowsTaskXmlPath() : `${script}.xml`;
  return ["/create", "/tn", TASK, "/xml", xml, "/f"];
}

/** Build the fixed scheduler-create command from an explicit staged XML document. */
export function buildWindowsSchtasksCreateArgsForXml(xml: string, replace = true): string[] {
  return ["/create", "/tn", TASK, "/xml", xml, ...(replace ? ["/f"] : [])];
}

/**
 * VBS launcher that starts the batch wrapper with a hidden window (style 0).
 * bWaitOnReturn=True keeps wscript.exe resident for the wrapper's lifetime so the
 * scheduled task stays "running": MultipleInstancesPolicy=IgnoreNew keeps preventing
 * duplicates and `schtasks /end` still has a live task instance to stop. Without the
 * launcher, the console batch action shows a closable cmd window in the interactive
 * session (issue #165). VBS string literals escape `"` as `""`.
 */
export function buildWindowsLauncherVbs(script = windowsServiceScriptPath()): string {
  const escaped = script.replace(/"/g, '""');
  const lines = [
    "' OpenCodex service launcher — runs the batch wrapper with a hidden window.",
    "' Generated by `ocx service install`; do not edit.",
    'Set shell = CreateObject("WScript.Shell")',
    // WshShell.Run(command, windowStyle 0 = hidden, bWaitOnReturn True = stay resident).
    `shell.Run """${escaped}""", 0, True`,
  ];
  return `${lines.join("\r\n")}\r\n`;
}

function windowsTaskDescription(attemptNonce?: string): string {
  return attemptNonce
    ? `OpenCodex proxy service wrapper; install-attempt=${attemptNonce}`
    : "OpenCodex proxy service wrapper";
}

/**
 * Session transitions that must be able to bring the proxy back.
 *
 * The task runs under `InteractiveToken`, so the proxy lives inside the interactive session
 * and Windows tears it down with that session — the wrapper records the kill as exit code
 * 1073807364 (`STATUS_CONTROL_C_EXIT`). With `LogonTrigger` as the only trigger there was no
 * recovery path short of a fresh logon, so signing out of a Remote Desktop session left the
 * proxy down until the next interactive logon. On one machine's logs 19 such kills produced
 * gaps of up to ~60 hours.
 *
 * These triggers do not stop the kill; they make it recoverable at the next connect. Console
 * transitions are included because a local session can be disconnected the same way, and
 * `MultipleInstancesPolicy=IgnoreNew` keeps a still-running proxy from being started twice.
 */
const WINDOWS_SESSION_RECOVERY_STATE_CHANGES = [
  "RemoteConnect",
  "SessionUnlock",
  "ConsoleConnect",
] as const;

export function buildWindowsTaskXml(
  script = windowsServiceScriptPath(),
  launcher = windowsLauncherVbsPath(),
  attemptNonce?: string,
  sessionTriggerUserId = cachedCurrentWindowsIdentity()?.sid,
): string {
  const escapedWscript = taskXmlString(windowsWscript());
  // Escape the launcher path independently for the <Arguments> element; quoting it
  // keeps spaces intact, and /b (batch mode) suppresses script error popups.
  const escapedLauncherArgs = taskXmlString(`/b /nologo "${launcher}"`);
  // `UserId` is optional in the schema, and omitting it makes a SessionStateChangeTrigger
  // fire for ANY account's session change. An unscoped LogonTrigger is read as "any user's
  // logon", which a non-elevated user may not register: schtasks /create answers "Access is
  // denied" for a task whose design (InteractiveToken + LeastPrivilege) needs no elevation
  // (#4425). Production registration resolves and passes the installing account SID
  // explicitly; the optional parameter remains only for deterministic builders/tests, and
  // the live validator rejects an unscoped recovery trigger.
  const sessionUserIdElement = sessionTriggerUserId
    ? `\n      <UserId>${taskXmlString(sessionTriggerUserId)}</UserId>`
    : "";
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${taskXmlString(windowsTaskDescription(attemptNonce))}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>${sessionUserIdElement}
    </LogonTrigger>
    ${WINDOWS_SESSION_RECOVERY_STATE_CHANGES.map(stateChange => `<SessionStateChangeTrigger>
      <Enabled>true</Enabled>${sessionUserIdElement}
      <StateChange>${stateChange}</StateChange>
    </SessionStateChangeTrigger>`).join("\n    ")}
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>4</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapedWscript}</Command>
      <Arguments>${escapedLauncherArgs}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

export type ExpectedWindowsTaskUserId = string | readonly string[];

export function cachedWindowsTaskUserIds(): readonly string[] | null {
  const identity = cachedCurrentWindowsIdentity();
  return identity ? [identity.sid, identity.name] : null;
}

export function resolvedWindowsTaskSid(): string {
  let identity = cachedCurrentWindowsIdentity();
  if (!identity) {
    const principal = resolveCurrentWindowsPrincipal(WINDOWS_PRINCIPAL_LOOKUP_TIMEOUT_MS);
    identity = cachedCurrentWindowsIdentity();
    if (!identity && /^\*S-1-(?:\d+-)+\d+$/i.test(principal)) return principal.slice(1).toUpperCase();
  }
  if (!identity) throw new Error("Windows Task Scheduler identity could not be resolved.");
  return identity.sid;
}

/** Render the exact UTF-16 task document published by production registration paths. */
export function buildWindowsTaskXmlDocument(
  script = windowsServiceScriptPath(),
  launcher = windowsLauncherVbsPath(),
  attemptNonce?: string,
  sessionTriggerUserId = resolvedWindowsTaskSid(),
): string {
  return `\uFEFF${buildWindowsTaskXml(script, launcher, attemptNonce, sessionTriggerUserId)}`;
}

export function taskXmlSection(xml: string, tag: string): string {
  return new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i").exec(xml)?.[1] ?? "";
}

/** Drop comments and CDATA so a commented-out decoy cannot satisfy any check. */
export function taskXmlWithoutCommentsAndCdata(xml: string): string {
  return xml.replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
}

/**
 * Count occurrences of an unprefixed tag, including the self-closing form. The
 * element boundary matters: `<EnabledExtra>` must not count as `Enabled`.
 */
export function taskXmlElementCount(xml: string, tag: string): number {
  return xml.match(new RegExp(`<${tag}(?:\\s[^>]*?)?\\s*\\/?>`, "gi"))?.length ?? 0;
}

/**
 * True when a namespace-prefixed form of the tag appears. A prefixed element bound
 * to the task namespace carries a real value, but this module parses by regex and
 * cannot resolve prefixes — so it fails closed instead of reading the element as
 * absent (which would silently apply the schema default).
 */
function taskXmlHasPrefixedTag(xml: string, tag: string): boolean {
  return new RegExp(`<[A-Za-z_][\\w.-]*:${tag}(?:[\\s/>])`, "i").test(xml);
}

/**
 * Compare an element that Task Scheduler may omit when exporting a registered task.
 * Absence means the documented schema default (#432); a present element must still
 * match exactly, so a malformed or explicitly unsafe value never reads as healthy.
 */
/**
 * Decode XML's five predefined entities, exactly once.
 *
 * Task Scheduler re-encodes element text when it exports a task, so a needle we
 * escaped ourselves can never match its output (#608). Compare decoded values
 * instead of encoded ones.
 *
 * The single pass is the point: decoding twice would turn `&amp;quot;` into `"`,
 * letting a doubly-encoded value impersonate the expected launcher path.
 */
function taskXmlDecodeEntities(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => (
    name === "amp" ? "&"
      : name === "lt" ? "<"
        : name === "gt" ? ">"
          : name === "quot" ? "\""
            : "'"
  ));
}

/**
 * Exactly one unprefixed `<tag>` whose DECODED text equals `expected`.
 *
 * Unlike taskXmlOptionalValueEquals(), an absent element is NOT a pass: these
 * elements name what actually gets executed, so a missing <Command>/<Arguments>
 * must fail the health check rather than inherit a schema default.
 */
function taskXmlDecodedValueEquals(xml: string, tag: string, expected: string): boolean {
  // Same reasoning as the optional helper: `<t:Arguments>` must not read as absent.
  if (taskXmlHasPrefixedTag(xml, tag)) return false;
  if (taskXmlElementCount(xml, tag) !== 1) return false;
  // `[^<]*` refuses nested markup, so a decoy inside a child element cannot match.
  const value = new RegExp(`<${tag}(?:\\s[^>]*?)?>([^<]*)<\\/${tag}>`, "i").exec(xml)?.[1];
  if (value === undefined) return false;
  return taskXmlDecodeEntities(value).trim().toLowerCase() === expected.trim().toLowerCase();
}

/**
 * Characters a console code page substitutes when it cannot carry the original.
 * Windows writes `?` per unrepresentable character, some layers write U+FFFD, and a
 * few drop them entirely.
 */
const CODE_PAGE_SUBSTITUTIONS = /^[?\uFFFD]*$/;

/**
 * Compare a value that OpenCodex itself wrote against what `schtasks /query /xml` read
 * back, tolerating ONLY the characters the console code page could not carry.
 *
 * `runFile` already reads the query as bytes, so this is not a spawn-decoding bug: the
 * conversion happens inside `schtasks` before the bytes exist. A profile named outside
 * the active code page — `C:\\Users\\김병준\\...` — comes back as `C:\\Users\\???\\...`, so an
 * exact comparison rejected a registration this process had just created correctly and
 * `ocx service install` rolled it back (#3064).
 *
 * The tolerance is deliberately narrow. Each unrepresentable RUN in the expected value
 * may match only a run of substitution characters — never arbitrary text, and never a
 * path separator. A wildcard as wide as `[^\\\\/]*` would leave a fully non-ASCII segment with
 * no anchors at all, so `C:\\Users\\김병준\\x.vbs` would match `C:\\Users\\Admin\\x.vbs` and this
 * process would adopt, repair, or delete another account's task. Accepting a foreign
 * live task is a worse failure than the rollback this fixes.
 */
function taskXmlLossyValueEquals(reported: string, expected: string): boolean {
  const a = reported.trim().toLowerCase();
  const b = expected.trim().toLowerCase();
  if (a === b) return true;
  // Nothing unrepresentable in the expectation means there was nothing to mangle,
  // so any difference is a real one.
  if (!/[^\x00-\x7F]/.test(b)) return false;
  const parts = b.split(/([^\x00-\x7F]+)/);
  let rest = a;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    if (i % 2 === 0) {
      // Literal ASCII run: it must be present verbatim, which is what keeps every
      // directory boundary and file name in the path verified.
      if (!rest.startsWith(part)) return false;
      rest = rest.slice(part.length);
      continue;
    }
    // Unrepresentable run: consume only substitution characters, and stop at the
    // next literal so a trailing run cannot swallow the remainder of the string.
    const next = parts[i + 1] ?? "";
    const end = next === "" ? rest.length : rest.indexOf(next);
    if (end < 0) return false;
    if (!CODE_PAGE_SUBSTITUTIONS.test(rest.slice(0, end))) return false;
    rest = rest.slice(end);
  }
  return rest === "";
}

function taskXmlDecodedLossyValueEquals(xml: string, tag: string, expected: string): boolean {
  if (taskXmlHasPrefixedTag(xml, tag)) return false;
  if (taskXmlElementCount(xml, tag) !== 1) return false;
  const value = new RegExp(`<${tag}(?:\\s[^>]*?)?>([^<]*)<\\/${tag}>`, "i").exec(xml)?.[1];
  if (value === undefined) return false;
  return taskXmlLossyValueEquals(taskXmlDecodeEntities(value), expected);
}

export function taskXmlOptionalValueEquals(xml: string, tag: string, expected: string): boolean {
  // Check the prefixed form first: treating `<t:Enabled>false</t:Enabled>` as an
  // omission would turn an explicitly disabled task into a healthy one.
  if (taskXmlHasPrefixedTag(xml, tag)) return false;
  const count = taskXmlElementCount(xml, tag);
  if (count === 0) return true;
  if (count > 1) return false;
  const value = new RegExp(`<${tag}(?:\\s[^>]*?)?>\\s*([^<]*?)\\s*<\\/${tag}>`, "i").exec(xml)?.[1];
  return value?.trim().toLowerCase() === expected.toLowerCase();
}

/** True only when the exported live task carries this install attempt's nonce. */
export function windowsTaskRegistrationOwnedByAttempt(xml: string, attemptNonce: string): boolean {
  if (!attemptNonce) return false;
  const scrubbed = taskXmlWithoutCommentsAndCdata(xml);
  if (taskXmlElementCount(scrubbed, "Data") > 0 || taskXmlHasPrefixedTag(scrubbed, "Data")) return false;
  if (taskXmlHasPrefixedTag(scrubbed, "RegistrationInfo")) return false;
  if (taskXmlElementCount(scrubbed, "RegistrationInfo") !== 1) return false;
  const registrationInfo = taskXmlSection(scrubbed, "RegistrationInfo");
  return taskXmlDecodedValueEquals(
    registrationInfo,
    "Description",
    windowsTaskDescription(attemptNonce),
  );
}

/**
 * Every session-recovery trigger present and enabled, scoped to <Triggers>.
 *
 * Each StateChange is matched inside its OWN <SessionStateChangeTrigger> element: a document
 * carrying one disabled trigger plus a different enabled one must not pass because the two
 * halves were found in unrelated elements.
 */
export function windowsTaskHasSessionRecoveryTriggers(
  triggers: string,
  expectedUserId: ExpectedWindowsTaskUserId | undefined,
): boolean {
  const scoped = triggers.match(/<SessionStateChangeTrigger(?:\s[^>]*)?>[\s\S]*?<\/SessionStateChangeTrigger>/gi) ?? [];
  return WINDOWS_SESSION_RECOVERY_STATE_CHANGES.every(stateChange =>
    scoped.some(element =>
      taskXmlDecodedValueEquals(element, "StateChange", stateChange)
      && taskXmlOptionalValueEquals(element, "Enabled", "true")
      && windowsTaskTriggerScopeAcceptable(element, expectedUserId)));
}

/**
 * A trigger's scope is acceptable only when it names the expected account exactly.
 *
 * An unscoped recovery trigger is not identity proof. Production registration resolves a SID
 * before writing XML; a missing scope therefore means the fixed-name task is legacy or foreign
 * and must be refreshed from an exact legacy snapshot or preserved for manual review.
 * Treating an unknown expected identity as a wildcard would let a fresh status process accept a
 * task bound to another user's session and suppress the repair that should replace it.
 */
function windowsTaskTriggerScopeAcceptable(
  element: string,
  expectedUserId: ExpectedWindowsTaskUserId | undefined,
): boolean {
  // A prefixed `<t:UserId>` is a real scope this validator cannot read: taskXmlElementCount()
  // counts only unprefixed tags, so without this the element below would look ABSENT and the
  // trigger would be accepted as unscoped even though it is bound to some other account.
  // Reject it outright rather than guess, and do so before the optional-field check.
  if (taskXmlHasPrefixedTag(element, "UserId")) return false;
  const userIdCount = taskXmlElementCount(element, "UserId");
  if (userIdCount === 0) return false;
  if (userIdCount !== 1) return false;
  if (expectedUserId === undefined) return false;
  // Scope is an identity boundary, unlike the launcher path. Newly generated tasks
  // use the locale-independent SID from cachedCurrentWindowsIdentity(), so there is
  // no reason to forgive code-page substitutions here. A lossy account-name compare
  // lets two non-ASCII users collapse to the same `???` value and can make repair
  // start another account's fixed-name task.
  const expectedValues = typeof expectedUserId === "string" ? [expectedUserId] : expectedUserId;
  return expectedValues.some(value => taskXmlDecodedValueEquals(element, "UserId", value));
}

/** Validate the stable OpenCodex action, principal, settings, and logon trigger. */
function windowsTaskRegistrationBaseHealthy(
  xml: string,
  wscript = windowsWscript(),
  launcher = windowsLauncherVbsPath(),
  allowLossyPaths = true,
): boolean {
  const scrubbed = taskXmlWithoutCommentsAndCdata(xml);
  // taskXmlSection() takes the FIRST match and the schema allows arbitrary XML under
  // Task/Data, so a Data block placed before the real sections could shadow them.
  // We never emit Data, so its presence alone disqualifies the registration. Both
  // forms are rejected because taskXmlElementCount() ignores prefixed tags.
  if (taskXmlElementCount(scrubbed, "Data") > 0 || taskXmlHasPrefixedTag(scrubbed, "Data")) return false;
  const triggers = taskXmlSection(scrubbed, "Triggers");
  const trigger = taskXmlSection(triggers, "LogonTrigger");
  const principal = taskXmlSection(scrubbed, "Principal");
  const settings = taskXmlSection(scrubbed, "Settings");
  const action = taskXmlSection(scrubbed, "Exec");
  // A self-closing <LogonTrigger /> leaves an empty section, so look for the element
  // itself — scoped to <Triggers> so a decoy elsewhere cannot satisfy it.
  return taskXmlElementCount(triggers, "LogonTrigger") > 0
    && taskXmlOptionalValueEquals(trigger, "Enabled", "true")
    && /<LogonType>\s*InteractiveToken\s*<\/LogonType>/i.test(principal)
    && taskXmlRunLevelAcceptable(principal)
    && taskXmlOptionalValueEquals(settings, "Enabled", "true")
    && /<MultipleInstancesPolicy>\s*IgnoreNew\s*<\/MultipleInstancesPolicy>/i.test(settings)
    && /<ExecutionTimeLimit>\s*PT0S\s*<\/ExecutionTimeLimit>/i.test(settings)
    // Compare decoded VALUES, not encodings: Task Scheduler canonicalizes the
    // quotes we wrote as `&quot;` back to literal `"` on export, so an escaped
    // needle never matched and a healthy task read as permanently stale (#608).
    // Case-insensitive: elevated `schtasks /create` may rewrite System32 casing.
    // Lossy on purpose: both name paths under the user profile, which the query
    // cannot carry when the profile is named outside the code page (#3064). Only
    // unrepresentable characters are forgiven; every ASCII segment and every
    // separator is still matched literally.
    && (allowLossyPaths
      ? taskXmlDecodedLossyValueEquals(action, "Command", wscript)
        && taskXmlDecodedLossyValueEquals(action, "Arguments", `/b /nologo "${launcher}"`)
      : taskXmlDecodedValueEquals(action, "Command", wscript)
        && taskXmlDecodedValueEquals(action, "Arguments", `/b /nologo "${launcher}"`));
}

/** Validate the security/lifecycle-critical fields of the registered scheduler task. */
export function windowsTaskRegistrationHealthy(
  xml: string,
  wscript = windowsWscript(),
  launcher = windowsLauncherVbsPath(),
  expectedUserId: ExpectedWindowsTaskUserId | null = cachedWindowsTaskUserIds(),
): boolean {
  const scrubbed = taskXmlWithoutCommentsAndCdata(xml);
  const triggers = taskXmlSection(scrubbed, "Triggers");
  return windowsTaskRegistrationBaseHealthy(xml, wscript, launcher)
    // Without these the task can only recover at the next logon, so a disconnected session
    // leaves the proxy down indefinitely. Treating their absence as unhealthy is what lets
    // an already-registered task from an older install get repaired instead of staying broken.
    && windowsTaskHasSessionRecoveryTriggers(triggers, expectedUserId ?? undefined);
}

/**
 * The only stale definition repair may replace automatically: the previous OpenCodex task
 * shape whose action/principal/settings are byte-exact and which has no session triggers yet.
 * Arbitrary unhealthy or partially modified fixed-name tasks are preserved for manual review.
 */
export function windowsTaskRegistrationRefreshableLegacy(
  xml: string,
  wscript = windowsWscript(),
  launcher = windowsLauncherVbsPath(),
): boolean {
  const scrubbed = taskXmlWithoutCommentsAndCdata(xml);
  const triggers = taskXmlSection(scrubbed, "Triggers");
  return windowsTaskRegistrationBaseHealthy(xml, wscript, launcher, false)
    && taskXmlElementCount(triggers, "SessionStateChangeTrigger") === 0
    && !taskXmlHasPrefixedTag(triggers, "SessionStateChangeTrigger");
}

export interface WindowsSchedulerXmlState {
  installed: boolean;
  enabled: boolean;
  registrationHealthy: boolean;
}

/**
 * Single source of truth for reading a registered task's XML. Both the status
 * diagnostic and its tests go through here, so a partial fix cannot leave one
 * caller on an older, stricter reading of the same document (#432).
 */
export function readWindowsSchedulerXmlState(
  xml: string,
  wscript?: string,
  launcher?: string,
  expectedUserId: ExpectedWindowsTaskUserId | null = cachedWindowsTaskUserIds(),
): WindowsSchedulerXmlState {
  const installed = xml.length > 0;
  if (!installed) return { installed: false, enabled: false, registrationHealthy: false };
  const scrubbed = taskXmlWithoutCommentsAndCdata(xml);
  const hasData = taskXmlElementCount(scrubbed, "Data") > 0 || taskXmlHasPrefixedTag(scrubbed, "Data");
  const settings = hasData ? "" : taskXmlSection(scrubbed, "Settings");
  return {
    installed: true,
    enabled: !hasData && taskXmlOptionalValueEquals(settings, "Enabled", "true"),
    registrationHealthy: windowsTaskRegistrationHealthy(xml, wscript, launcher, expectedUserId),
  };
}

// ── macOS (launchd) ──
/** Read a file as UTF-8, or null when it is absent/unreadable. */
export function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
