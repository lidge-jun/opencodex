import { afterEach, describe, expect, test } from "bun:test";
import {
  buildWindowsTaskXml,
  decodeSchtasksOutput,
  evaluateWindowsSchedulerInstallVerification,
  formatWindowsSchedulerServiceStatus,
  inspectWindowsSchedulerServiceStatus,
  probeWindowsSchedulerTask,
  schedulerVerificationMaySettle,
  setQuerySchtasksForTests,
  windowsSchedulerCsvIncludesTask,
  windowsSchedulerTaskInstalled,
  windowsTaskRegistrationHealthy,
} from "../src/service";

const TEST_WINDOWS_TASK_SID = "S-1-5-21-111-222-333-1001";

afterEach(() => {
  setQuerySchtasksForTests(null);
});

describe("decodeSchtasksOutput", () => {
  test("decodes UTF-16LE BOM XML that would fail as UTF-8", () => {
    // Pin <Command> the way the sibling describe block below does: buildWindowsTaskXml()
    // resolves it through windowsWscript(), which falls back to a bare "wscript.exe" off
    // Windows because the System32 path does not exist. Without this the fixture only
    // matches on a Windows host and the decoder assertion fails everywhere else.
    const wscript = "C:\\WINDOWS\\System32\\wscript.exe";
    const xml = buildWindowsTaskXml(
      "C:\\Users\\x\\.opencodex\\opencodex-service.cmd",
      "C:\\Users\\x\\.opencodex\\opencodex-service-launcher.vbs",
      undefined,
      TEST_WINDOWS_TASK_SID,
    ).replace(/<Command>.*?<\/Command>/, `<Command>${wscript}</Command>`);
    const utf16 = Buffer.from(`\uFEFF${xml}`, "utf16le");
    const decoded = decodeSchtasksOutput(utf16);
    expect(decoded.startsWith("<?xml")).toBe(true);
    expect(windowsTaskRegistrationHealthy(
      decoded,
      wscript,
      "C:\\Users\\x\\.opencodex\\opencodex-service-launcher.vbs",
      TEST_WINDOWS_TASK_SID,
    )).toBe(true);
    // Sanity: the historical utf8 mis-decode is unhealthy.
    expect(windowsTaskRegistrationHealthy(utf16.toString("utf8"))).toBe(false);
  });

  test("keeps plain UTF-8 schtasks text listings intact", () => {
    const text = "Folder: \\\nTaskName: opencodex-proxy";
    expect(decodeSchtasksOutput(Buffer.from(text, "utf8"))).toBe(text);
  });
});

describe("windowsSchedulerCsvIncludesTask", () => {
  test("matches quoted Task Scheduler CSV task names", () => {
    const csv = [
      `"TaskName","Next Run Time","Status"`,
      `"\\opencodex-proxy","N/A","Ready"`,
      `"\\Other Task","N/A","Ready"`,
    ].join("\n");
    expect(windowsSchedulerCsvIncludesTask(csv, "opencodex-proxy")).toBe(true);
    expect(windowsSchedulerCsvIncludesTask(csv, "missing-task")).toBe(false);
    expect(windowsSchedulerCsvIncludesTask(csv, "opencodex")).toBe(false);
  });
});

describe("probeWindowsSchedulerTask", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
    setQuerySchtasksForTests(null);
  });

  test("returns present when the specific /tn query includes the task", () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    setQuerySchtasksForTests((args) => {
      if (args[0] === "/query" && args[1] === "/tn") return "Folder: \\\nTaskName: opencodex-proxy";
      throw new Error("unexpected query");
    });
    expect(probeWindowsSchedulerTask("opencodex-proxy")).toEqual({ status: "present" });
    expect(windowsSchedulerTaskInstalled("opencodex-proxy")).toBe(true);
  });

  test("recognizes the task without exposing mojibake from localized table output", () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    const localizedTable = [
      "����: \\",
      "�۾� �̸�                                ���� ���� �ð�         ����",
      "======================================== ====================== ===============",
      "opencodex-proxy                          N/A                    �غ�",
    ].join("\n");
    setQuerySchtasksForTests(() => localizedTable);

    const result = formatWindowsSchedulerServiceStatus(
      probeWindowsSchedulerTask("opencodex-proxy"),
      { status: "running", port: 10100 },
    );

    expect(result).toBe("✅ service installed (Task Scheduler); OpenCodex proxy running on port 10100.");
    expect(result).not.toContain("����");
    expect(result).not.toContain("�۾�");
  });

  test("falls back to CSV listing when the specific query fails", () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    setQuerySchtasksForTests((args) => {
      if (args.includes("/tn")) throw new Error("Access is denied.");
      if (args.includes("CSV")) {
        return `"TaskName"\n"\\opencodex-proxy"\n`;
      }
      throw new Error("unexpected query");
    });
    expect(probeWindowsSchedulerTask("opencodex-proxy")).toEqual({ status: "present" });
  });

  test("returns absent when specific query fails and CSV succeeds without the task", () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    setQuerySchtasksForTests((args) => {
      if (args.includes("/tn")) throw new Error("ERROR: The system cannot find the file specified.");
      if (args.includes("CSV")) return `"TaskName"\n"\\other-task"\n`;
      throw new Error("unexpected query");
    });
    expect(probeWindowsSchedulerTask("opencodex-proxy")).toEqual({ status: "absent" });
    expect(windowsSchedulerTaskInstalled("opencodex-proxy")).toBe(false);
  });

  test("returns unknown with both details when specific query and CSV listing fail", () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    setQuerySchtasksForTests((args) => {
      if (args.includes("/tn")) throw new Error("Access is denied.");
      if (args.includes("CSV")) throw new Error("RPC server is unavailable.");
      throw new Error("unexpected query");
    });
    const probe = probeWindowsSchedulerTask("opencodex-proxy");
    expect(probe.status).toBe("unknown");
    if (probe.status !== "unknown") throw new Error("expected unknown");
    expect(probe.detail).toContain("Access is denied.");
    expect(probe.detail).toContain("RPC server is unavailable.");
    expect(windowsSchedulerTaskInstalled("opencodex-proxy")).toBe(false);
  });
});

describe("formatWindowsSchedulerServiceStatus", () => {
  test("reports task and identity-checked proxy state independently", () => {
    expect(formatWindowsSchedulerServiceStatus({ status: "present" }, { status: "not-running" }))
      .toBe("⚠️  service installed (Task Scheduler); OpenCodex proxy not running.");
    expect(formatWindowsSchedulerServiceStatus({ status: "present" }, { status: "unknown" }))
      .toBe("⚠️  service installed (Task Scheduler); OpenCodex proxy status unknown.");
    expect(formatWindowsSchedulerServiceStatus({ status: "absent" }, { status: "running", port: 3593 }))
      .toBe("❌ service not installed (Task Scheduler); OpenCodex proxy is running independently on port 3593.");
    expect(formatWindowsSchedulerServiceStatus({ status: "absent" }, { status: "not-running" }))
      .toBe("❌ service not installed (Task Scheduler).");
    expect(formatWindowsSchedulerServiceStatus({ status: "unknown", detail: "����" }, { status: "running", port: 10100 }))
      .toBe("⚠️  Task Scheduler registration unknown; OpenCodex proxy running on port 10100.");
    expect(formatWindowsSchedulerServiceStatus({ status: "unknown", detail: "����" }, { status: "not-running" }))
      .toBe("⚠️  service status unknown (Task Scheduler query failed); OpenCodex proxy not running.");
  });

  test("keeps scheduler and runtime probe failures locale-independent", async () => {
    const status = await inspectWindowsSchedulerServiceStatus({
      probeTask: () => { throw new Error("���� ����"); },
      findProxy: async () => { throw new Error("connection failure"); },
    });

    expect(status).toBe("⚠️  service status unknown (Task Scheduler and proxy checks failed).");
    expect(status).not.toContain("����");
    expect(status).not.toContain("connection failure");
  });
});

describe("evaluateWindowsSchedulerInstallVerification", () => {
  const wscript = "C:\\Windows\\System32\\wscript.exe";
  const launcher = "C:\\Users\\Test\\.opencodex\\opencodex-service-launcher.vbs";
  const healthyXml = buildWindowsTaskXml("ignored.cmd", launcher, undefined, TEST_WINDOWS_TASK_SID)
    .replace(/<Command>.*?<\/Command>/, `<Command>${wscript}</Command>`);

  test("succeeds when task, registration, assets, and absent WinSW all hold", () => {
    expect(windowsTaskRegistrationHealthy(healthyXml, wscript, launcher, TEST_WINDOWS_TASK_SID)).toBe(true);
    const result = evaluateWindowsSchedulerInstallVerification({
      taskInstalled: true,
      xml: healthyXml,
      assetsExist: true,
      nativeStatus: "nonexistent",
      wscript,
      launcher,
      expectedUserId: TEST_WINDOWS_TASK_SID,
    });
    expect(result).toMatchObject({
      ok: true,
      conflict: false,
      nativeServiceAbsent: true,
      registrationHealthy: true,
      assetsHealthy: true,
      detail: "ok",
    });
  });

  test("fails with conflict when WinSW remains installed", () => {
    const result = evaluateWindowsSchedulerInstallVerification({
      taskInstalled: true,
      xml: healthyXml,
      assetsExist: true,
      nativeStatus: "stopped",
      wscript,
      launcher,
      expectedUserId: TEST_WINDOWS_TASK_SID,
    });
    expect(result.ok).toBe(false);
    expect(result.conflict).toBe(true);
    expect(result.nativeServiceAbsent).toBe(false);
    expect(result.detail).toContain("CONFLICT");
  });

  test("fails when both scheduler and WinSW report present", () => {
    const result = evaluateWindowsSchedulerInstallVerification({
      taskInstalled: true,
      xml: healthyXml,
      assetsExist: true,
      nativeStatus: "started",
      wscript,
      launcher,
      expectedUserId: TEST_WINDOWS_TASK_SID,
    });
    expect(result.ok).toBe(false);
    expect(result.conflict).toBe(true);
  });

  test("treats unknown WinSW status as unverified, not as a conflict", () => {
    const result = evaluateWindowsSchedulerInstallVerification({
      taskInstalled: true,
      xml: healthyXml,
      assetsExist: true,
      nativeStatus: "unknown",
      wscript,
      launcher,
      expectedUserId: TEST_WINDOWS_TASK_SID,
    });
    expect(result.ok).toBe(false);
    expect(result.conflict).toBe(false);
    expect(result.nativeStatusUnknown).toBe(true);
    expect(result.nativeServiceAbsent).toBe(false);
    expect(result.detail).toContain("could not verify");
    expect(result.detail).not.toContain("CONFLICT");
  });

  test("fails when registration health is invalid", () => {
    const badXml = healthyXml.replace("<LogonTrigger>", "<BootTrigger>");
    const result = evaluateWindowsSchedulerInstallVerification({
      taskInstalled: true,
      xml: badXml,
      assetsExist: true,
      nativeStatus: "nonexistent",
      wscript,
      launcher,
      expectedUserId: TEST_WINDOWS_TASK_SID,
    });
    expect(result.ok).toBe(false);
    expect(result.registrationHealthy).toBe(false);
    expect(result.detail).toContain("unhealthy");
  });

  test("a published-but-invalid registration never enters the settle loop", () => {
    const badXml = healthyXml.replace("<LogonTrigger>", "<BootTrigger>");
    const invalid = evaluateWindowsSchedulerInstallVerification({
      taskInstalled: true,
      xml: badXml,
      assetsExist: true,
      nativeStatus: "nonexistent",
      wscript,
      launcher,
      expectedUserId: TEST_WINDOWS_TASK_SID,
    });
    expect(invalid.registrationHealthy).toBe(false);
    expect(invalid.registrationInvalid).toBe(true);
    // Permanent: rollback must fire immediately, with zero settle delays.
    expect(schedulerVerificationMaySettle(invalid)).toBe(false);

    // An empty/unreadable view is publication lag: still transient.
    const pending = evaluateWindowsSchedulerInstallVerification({
      taskInstalled: false,
      xml: "",
      assetsExist: true,
      nativeStatus: "nonexistent",
      wscript,
      launcher,
    });
    expect(pending.registrationInvalid).toBe(false);
    expect(schedulerVerificationMaySettle(pending)).toBe(true);

    // A <Data> block is an explicit permanent violation too.
    const dataXml = healthyXml.replace("<Triggers>", "<Data>x</Data><Triggers>");
    const withData = evaluateWindowsSchedulerInstallVerification({
      taskInstalled: true,
      xml: dataXml,
      assetsExist: true,
      nativeStatus: "nonexistent",
      wscript,
      launcher,
      expectedUserId: TEST_WINDOWS_TASK_SID,
    });
    expect(withData.registrationInvalid).toBe(true);
    expect(schedulerVerificationMaySettle(withData)).toBe(false);
  });

  test("fails when required assets are missing", () => {
    const result = evaluateWindowsSchedulerInstallVerification({
      taskInstalled: true,
      xml: healthyXml,
      assetsExist: false,
      nativeStatus: "nonexistent",
      wscript,
      launcher,
      expectedUserId: TEST_WINDOWS_TASK_SID,
    });
    expect(result.ok).toBe(false);
    expect(result.assetsHealthy).toBe(false);
    expect(result.detail).toContain("assets are missing");
  });

  test("fails when scheduler task is absent", () => {
    const result = evaluateWindowsSchedulerInstallVerification({
      taskInstalled: false,
      xml: "",
      assetsExist: true,
      nativeStatus: "nonexistent",
      wscript,
      launcher,
    });
    expect(result.ok).toBe(false);
    expect(result.taskInstalled).toBe(false);
    expect(result.detail).toContain("not installed");
  });
});
