import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir, userInfo } from "node:os";
import type { OcxConfig } from "../src/types";
import { handleNativeProfileAPI } from "../src/codex/native-profile-api";
import type { NativeProfileManager } from "../src/codex/native-profile-manager";
import { NativeProfileError } from "../src/codex/native-profile-types";
import {
  codexAccountSelectionForTurn,
  resetLifecycleDrainStateForTests,
  tryAdmitTurn,
} from "../src/server/lifecycle";
import {
  blockNativeMainRecovery,
  completeNativeMainRecovery,
  initializeNativeMainStartupGate,
  nativeMainStartupGateSnapshot,
} from "../src/codex/native-profile-startup";

const originalCodexHome = process.env.CODEX_HOME;

afterEach(() => {
  resetLifecycleDrainStateForTests();
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
});

describe("native main profile management API", () => {
  test("long Direct/non-main work does not block switch while new main selection is fenced", async () => {
    const longPoolTurn = tryAdmitTurn();
    expect(longPoolTurn).not.toBeNull();
    let checkedScopedAdmission = false;
    const manager = {
      switch: async () => {
        const directOrPoolTurn = tryAdmitTurn();
        expect(directOrPoolTurn).not.toBeNull();
        const selection = codexAccountSelectionForTurn(directOrPoolTurn!)!();
        expect(selection?.mainProfileDraining).toBe(true);
        expect(selection?.claimMainProfile()).toBe(false);
        selection?.release();
        directOrPoolTurn?.release();
        checkedScopedAdmission = true;
        return { ok: true };
      },
    } as unknown as NativeProfileManager;
    const request = new Request("http://localhost/api/native-main-profiles/switch", {
      method: "POST",
      body: JSON.stringify({ target: "target", confirmedStopped: true }),
    });
    try {
      const response = await handleNativeProfileAPI(request, new URL(request.url), {} as OcxConfig, { manager });
      expect(response?.status).toBe(200);
      expect(checkedScopedAdmission).toBe(true);
    } finally {
      longPoolTurn?.release();
    }
  });

  test("real drain timeout leaves an admitted HTTP response live and never enters switch", async () => {
    const lease = tryAdmitTurn();
    expect(lease).not.toBeNull();
    const selection = codexAccountSelectionForTurn(lease!)!();
    expect(selection?.claimMainProfile()).toBe(true);
    selection?.release();
    let switched = 0;
    const manager = { switch: async () => { switched += 1; return { ok: true }; } } as unknown as NativeProfileManager;
    const request = new Request("http://localhost/api/native-main-profiles/switch", {
      method: "POST",
      body: JSON.stringify({ target: "target", confirmedStopped: true }),
    });
    try {
      const response = await handleNativeProfileAPI(request, new URL(request.url), {} as OcxConfig, {
        manager,
        drainTimeoutMs: 0,
      });
      expect(response?.status).toBe(409);
      expect(await response?.json()).toMatchObject({ code: "MAIN_REQUESTS_ACTIVE", retryable: true });
      expect(switched).toBe(0);
    } finally {
      lease?.release();
    }
  });

  test("stale HTTP/Responses-WebSocket work settles before switch and new turns stay fenced", async () => {
    const oldTurn = tryAdmitTurn();
    expect(oldTurn).not.toBeNull();
    const oldSelection = codexAccountSelectionForTurn(oldTurn!)!();
    expect(oldSelection?.claimMainProfile()).toBe(true);
    oldSelection?.release();
    const order: string[] = [];
    let slept = false;
    let after: ReturnType<typeof tryAdmitTurn> = null;
    try {
      const manager = {
        switch: async () => { order.push("switch"); return { ok: true }; },
      } as unknown as NativeProfileManager;
      const request = new Request("http://localhost/api/native-main-profiles/switch", {
        method: "POST",
        body: JSON.stringify({ target: "target", confirmedStopped: true }),
      });
      const response = await handleNativeProfileAPI(request, new URL(request.url), {} as OcxConfig, {
        manager,
        drainTimeoutMs: 1_000,
        sleep: async () => {
          if (slept) return Bun.sleep(1);
          slept = true;
          const concurrentPool = tryAdmitTurn();
          expect(concurrentPool).not.toBeNull();
          const concurrentSelection = codexAccountSelectionForTurn(concurrentPool!)!();
          expect(concurrentSelection?.mainProfileDraining).toBe(true);
          expect(concurrentSelection?.claimMainProfile()).toBe(false);
          concurrentSelection?.release();
          concurrentPool?.release();
          order.push("old-http-or-ws-response-finished");
          oldTurn?.release();
        },
      });
      expect(response?.status).toBe(200);
      expect(order).toEqual(["old-http-or-ws-response-finished", "switch"]);
      after = tryAdmitTurn();
      expect(after).not.toBeNull();
    } finally {
      oldTurn?.release();
      after?.release();
    }
  });

  test("length-unknown native-profile bodies use the bounded management reader", async () => {
    let registered = false;
    const manager = {
      register: async () => { registered = true; return { ok: true }; },
    } as unknown as NativeProfileManager;
    const request = new Request("http://localhost/api/native-main-profiles/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "large", padding: "x".repeat(4 * 1024 * 1024 + 1) }),
    });
    expect(request.headers.has("content-length")).toBe(false);

    const response = await handleNativeProfileAPI(request, new URL(request.url), {} as OcxConfig, { manager });

    expect(response?.status).toBe(413);
    expect(registered).toBe(false);
  });

  test("constructor failures remain inside the redacted management error boundary", async () => {
    const missingHome = join(tmpdir(), `ocx-native-profile-missing-${crypto.randomUUID()}`);
    process.env.CODEX_HOME = missingHome;
    const request = new Request("http://localhost/api/native-main-profiles");

    const response = await handleNativeProfileAPI(
      request,
      new URL(request.url),
      {} as OcxConfig,
    );

    expect(response).not.toBeNull();
    expect(response!.status).toBeGreaterThanOrEqual(400);
    const payload = JSON.stringify(await response!.json());
    expect(payload).not.toContain(missingHome);
    expect(payload).not.toContain(userInfo().username);
  });

  test("pending-recovery errors retain actionable public recovery commands", async () => {
    const message = "A native-profile recovery journal is pending. Run `ocx account main recover` or `ocx account main recover --rollback --yes` before registering or adding profiles.";
    const manager = {
      register: async () => { throw new NativeProfileError("RECOVERY_REQUIRED", message, 409); },
    } as unknown as NativeProfileManager;
    const request = new Request("http://localhost/api/native-main-profiles/register", {
      method: "POST",
      body: JSON.stringify({ label: "personal" }),
    });

    const response = await handleNativeProfileAPI(request, new URL(request.url), {} as OcxConfig, { manager });

    expect(response?.status).toBe(409);
    const payload = await response?.json() as Record<string, unknown>;
    expect(payload).toMatchObject({ code: "RECOVERY_REQUIRED", error: message });
    expect("cleanupRequired" in payload).toBe(false);
  });

  test("finish returns a typed non-200 after server-owned stage cleanup without a cleanup warning", async () => {
    const message = "A native-profile recovery journal is pending. Run `ocx account main recover` before adding profiles.";
    const manager = {
      finishStage: async () => { throw new NativeProfileError("RECOVERY_REQUIRED", message, 409); },
    } as unknown as NativeProfileManager;
    const request = new Request("http://localhost/api/native-main-profiles/stage/finish", {
      method: "POST",
      body: JSON.stringify({ stageId: "11111111-1111-4111-8111-111111111111", writerToken: "writer-token", label: "work" }),
    });

    const response = await handleNativeProfileAPI(request, new URL(request.url), {} as OcxConfig, { manager });

    expect(response?.status).toBe(409);
    const payload = await response?.json() as Record<string, unknown>;
    expect(payload).toMatchObject({ code: "RECOVERY_REQUIRED", error: message });
    expect("cleanupRequired" in payload).toBe(false);
  });

  test("cleanup-required failures preserve the primary error and expose a true-only signal", async () => {
    const message = "The staged native login is invalid.";
    const manager = {
      finishStage: async () => {
        throw new NativeProfileError("AUTH_INVALID", message, 422, true, true, true);
      },
    } as unknown as NativeProfileManager;
    const request = new Request("http://localhost/api/native-main-profiles/stage/finish", {
      method: "POST",
      body: JSON.stringify({ stageId: "11111111-1111-4111-8111-111111111111", writerToken: "writer-token", label: "work" }),
    });

    const response = await handleNativeProfileAPI(request, new URL(request.url), {} as OcxConfig, { manager });

    expect(response?.status).toBe(422);
    expect(await response?.json()).toEqual({
      error: message,
      code: "AUTH_INVALID",
      retryable: true,
      cleanupRequired: true,
      plaintextMayRemain: true,
    });
  });

  test("successful switch auto-recovery completes the matching startup gate before releasing its drain lease", async () => {
    const homeId = "home-switch-gate";
    await initializeNativeMainStartupGate({
      manager: {
        context: { homeId, journalPath: "pending", recoveryBlockPath: "block" },
        recover: async () => { throw new NativeProfileError("RECOVERY_REQUIRED", "manual", 409); },
      } as unknown as NativeProfileManager,
      probeRecoveryState: () => "journal",
    });
    expect(nativeMainStartupGateSnapshot()).toMatchObject({ status: "blocked", homeId });
    let completedWhileDraining = false;
    const manager = {
      context: { homeId, journalPath: "pending", recoveryBlockPath: "block" },
      switch: async () => ({ ok: true }),
    } as unknown as NativeProfileManager;
    const request = new Request("http://localhost/api/native-main-profiles/switch", {
      method: "POST",
      body: JSON.stringify({ target: "target", confirmedStopped: true }),
    });
    const response = await handleNativeProfileAPI(request, new URL(request.url), {} as OcxConfig, {
      manager,
      probeRecoveryState: (() => {
        const states = ["journal", "none"] as const;
        return () => states.shift() ?? "none";
      })(),
      completeRecovery: id => {
        const turn = tryAdmitTurn();
        const selection = codexAccountSelectionForTurn(turn!)!();
        completedWhileDraining = turn !== null
          && selection?.mainProfileDraining === true
          && selection.claimMainProfile() === false;
        selection?.release();
        turn?.release();
        return completeNativeMainRecovery(id);
      },
    });
    expect(response?.status).toBe(200);
    expect(completedWhileDraining).toBe(true);
    expect(nativeMainStartupGateSnapshot()).toMatchObject({ status: "ready", homeId });
  });

  test("successful switch clears a matching stale startup gate after clean recovery probes", async () => {
    const homeId = "home-stale-blocked-clean";
    await initializeNativeMainStartupGate({
      manager: { context: { homeId } } as unknown as NativeProfileManager,
      probeRecoveryState: () => { throw new Error("startup recovery state was unreadable"); },
    });
    expect(nativeMainStartupGateSnapshot()).toEqual({
      status: "blocked",
      homeId,
      reason: "manual-recovery",
    });
    let completedWhileDraining = false;
    const manager = {
      context: { homeId, journalPath: "missing", recoveryBlockPath: "missing" },
      switch: async () => ({ ok: true }),
    } as unknown as NativeProfileManager;
    const request = new Request("http://localhost/api/native-main-profiles/switch", {
      method: "POST",
      body: JSON.stringify({ target: "target", confirmedStopped: true }),
    });

    const response = await handleNativeProfileAPI(request, new URL(request.url), {} as OcxConfig, {
      manager,
      probeRecoveryState: () => "none",
      completeRecovery: id => {
        const turn = tryAdmitTurn();
        const selection = codexAccountSelectionForTurn(turn!)!();
        completedWhileDraining = turn !== null
          && selection?.mainProfileDraining === true
          && selection.claimMainProfile() === false;
        selection?.release();
        turn?.release();
        return completeNativeMainRecovery(id);
      },
    });

    expect(response?.status).toBe(200);
    expect(completedWhileDraining).toBe(true);
    expect(nativeMainStartupGateSnapshot()).toEqual({ status: "ready", homeId });
  });

  test("failed switch cannot clear a matching stale startup gate from clean probes", async () => {
    const homeId = "home-stale-blocked-failed-switch";
    await initializeNativeMainStartupGate({
      manager: { context: { homeId } } as unknown as NativeProfileManager,
      probeRecoveryState: () => { throw new Error("startup recovery state was unreadable"); },
    });
    let completions = 0;
    const manager = {
      context: { homeId, journalPath: "missing", recoveryBlockPath: "missing" },
      switch: async () => { throw new NativeProfileError("RECOVERY_REQUIRED", "switch failed", 409); },
    } as unknown as NativeProfileManager;
    const request = new Request("http://localhost/api/native-main-profiles/switch", {
      method: "POST",
      body: JSON.stringify({ target: "target", confirmedStopped: true }),
    });

    const response = await handleNativeProfileAPI(request, new URL(request.url), {} as OcxConfig, {
      manager,
      probeRecoveryState: () => "none",
      completeRecovery: () => { completions += 1; return true; },
    });

    expect(response?.status).toBe(409);
    expect(completions).toBe(0);
    expect(nativeMainStartupGateSnapshot()).toEqual({
      status: "blocked",
      homeId,
      reason: "manual-recovery",
    });
  });

  test("successful switch cannot clear a stale startup gate for another home", async () => {
    const blockedHomeId = "home-stale-blocked-owner";
    await initializeNativeMainStartupGate({
      manager: { context: { homeId: blockedHomeId } } as unknown as NativeProfileManager,
      probeRecoveryState: () => { throw new Error("startup recovery state was unreadable"); },
    });
    let completions = 0;
    const manager = {
      context: { homeId: "home-clean-switch", journalPath: "missing", recoveryBlockPath: "missing" },
      switch: async () => ({ ok: true }),
    } as unknown as NativeProfileManager;
    const request = new Request("http://localhost/api/native-main-profiles/switch", {
      method: "POST",
      body: JSON.stringify({ target: "target", confirmedStopped: true }),
    });

    const response = await handleNativeProfileAPI(request, new URL(request.url), {} as OcxConfig, {
      manager,
      probeRecoveryState: () => "none",
      completeRecovery: () => { completions += 1; return true; },
    });

    expect(response?.status).toBe(200);
    expect(completions).toBe(0);
    expect(nativeMainStartupGateSnapshot()).toEqual({
      status: "blocked",
      homeId: blockedHomeId,
      reason: "manual-recovery",
    });
  });

  test("a retained journal publishes a matching main gate before drain release while pool turns remain available", async () => {
    const homeId = "home-clean-retained-journal";
    await initializeNativeMainStartupGate({
      manager: { context: { homeId } } as unknown as NativeProfileManager,
      probeRecoveryState: () => "none",
    });
    let gateClosedBeforeDrainRelease = false;
    const states = ["none", "journal"] as const;
    const manager = {
      context: { homeId, journalPath: "pending", recoveryBlockPath: "missing-block" },
      switch: async () => { throw new NativeProfileError("RECOVERY_REQUIRED", "journal retained", 409); },
    } as unknown as NativeProfileManager;
    const request = new Request("http://localhost/api/native-main-profiles/switch", {
      method: "POST",
      body: JSON.stringify({ target: "target", confirmedStopped: true }),
    });

    const response = await handleNativeProfileAPI(request, new URL(request.url), {} as OcxConfig, {
      manager,
      probeRecoveryState: () => states.shift() ?? "journal",
      blockRecovery: (id, state) => {
        const blocked = blockNativeMainRecovery(id, state);
        const poolTurn = tryAdmitTurn();
        const selection = codexAccountSelectionForTurn(poolTurn!)!();
        gateClosedBeforeDrainRelease = blocked
          && nativeMainStartupGateSnapshot().status === "blocked"
          && poolTurn !== null
          && selection?.mainProfileDraining === true
          && selection.claimMainProfile() === false;
        selection?.release();
        poolTurn?.release();
        return blocked;
      },
    });

    expect(response?.status).toBe(409);
    expect(gateClosedBeforeDrainRelease).toBe(true);
    expect(nativeMainStartupGateSnapshot()).toEqual({
      status: "blocked",
      homeId,
      reason: "recovery-pending",
    });
    const admittedAfterDrain = tryAdmitTurn();
    expect(admittedAfterDrain).not.toBeNull();
    admittedAfterDrain?.release();
  });

  test("switch without auto-recovery does not complete a blocked startup gate", async () => {
    const homeId = "home-no-journal";
    await initializeNativeMainStartupGate({
      manager: { context: { homeId } } as unknown as NativeProfileManager,
      probeRecoveryState: () => "none",
    });
    let completions = 0;
    let blocks = 0;
    const manager = {
      context: { homeId, journalPath: "missing", recoveryBlockPath: "missing-block" },
      switch: async () => ({ ok: true }),
    } as unknown as NativeProfileManager;
    const request = new Request("http://localhost/api/native-main-profiles/switch", {
      method: "POST",
      body: JSON.stringify({ target: "target", confirmedStopped: true }),
    });
    const response = await handleNativeProfileAPI(request, new URL(request.url), {} as OcxConfig, {
      manager,
      probeRecoveryState: () => "none",
      blockRecovery: () => { blocks += 1; return true; },
      completeRecovery: () => { completions += 1; return true; },
    });
    expect(response?.status).toBe(200);
    expect(completions).toBe(0);
    expect(blocks).toBe(0);
    expect(nativeMainStartupGateSnapshot()).toEqual({ status: "ready", homeId });
  });

  test("a retained recovery state cannot fence a known different native home", async () => {
    await initializeNativeMainStartupGate({
      manager: { context: { homeId: "home-a" } } as unknown as NativeProfileManager,
      probeRecoveryState: () => "none",
    });
    const states = ["none", "manual"] as const;
    const manager = {
      context: { homeId: "home-b", journalPath: "missing", recoveryBlockPath: "manual" },
      switch: async () => { throw new NativeProfileError("RECOVERY_REQUIRED", "manual marker retained", 409); },
    } as unknown as NativeProfileManager;
    const request = new Request("http://localhost/api/native-main-profiles/switch", {
      method: "POST",
      body: JSON.stringify({ target: "target", confirmedStopped: true }),
    });

    const response = await handleNativeProfileAPI(request, new URL(request.url), {} as OcxConfig, {
      manager,
      probeRecoveryState: () => states.shift() ?? "manual",
    });

    expect(response?.status).toBe(409);
    expect(nativeMainStartupGateSnapshot()).toEqual({ status: "ready", homeId: "home-a" });
  });

  test("an indeterminate post-operation recovery probe closes the matching gate", async () => {
    const homeId = "home-indeterminate";
    await initializeNativeMainStartupGate({
      manager: { context: { homeId } } as unknown as NativeProfileManager,
      probeRecoveryState: () => "none",
    });
    let probes = 0;
    const manager = {
      context: { homeId, journalPath: "unknown", recoveryBlockPath: "unknown" },
      switch: async () => ({ ok: true }),
    } as unknown as NativeProfileManager;
    const request = new Request("http://localhost/api/native-main-profiles/switch", {
      method: "POST",
      body: JSON.stringify({ target: "target", confirmedStopped: true }),
    });

    const response = await handleNativeProfileAPI(request, new URL(request.url), {} as OcxConfig, {
      manager,
      probeRecoveryState: () => {
        if (probes++ === 0) return "none";
        throw new Error("recovery state unreadable");
      },
    });

    expect(response?.status).toBe(500);
    expect(nativeMainStartupGateSnapshot()).toEqual({
      status: "blocked",
      homeId,
      reason: "manual-recovery",
    });
  });

  test("explicit recovery completes a manual marker gate only after the marker clears", async () => {
    const homeId = "home-manual-clear";
    await initializeNativeMainStartupGate({
      manager: { context: { homeId }, recover: async () => ({}) } as unknown as NativeProfileManager,
      probeRecoveryState: () => "manual",
    });
    let completions = 0;
    const manager = {
      context: { homeId, journalPath: "missing", recoveryBlockPath: "block" },
      recover: async () => ({ ok: true, recovered: true, action: "confirm-current-owner" }),
    } as unknown as NativeProfileManager;
    const states = ["manual", "none"] as const;
    const request = new Request("http://localhost/api/native-main-profiles/recover", {
      method: "POST",
      body: JSON.stringify({ rollback: false }),
    });
    const response = await handleNativeProfileAPI(request, new URL(request.url), {} as OcxConfig, {
      manager,
      probeRecoveryState: () => states.shift() ?? "none",
      completeRecovery: id => {
        completions += 1;
        return completeNativeMainRecovery(id);
      },
    });
    expect(response?.status).toBe(200);
    expect(completions).toBe(1);
    expect(nativeMainStartupGateSnapshot()).toMatchObject({ status: "ready", homeId });
  });

  test("retained manual markers and failed recovery never complete the gate", async () => {
    const homeId = "home-manual-retained";
    await initializeNativeMainStartupGate({
      manager: { context: { homeId }, recover: async () => ({}) } as unknown as NativeProfileManager,
      probeRecoveryState: () => "manual",
    });
    let completions = 0;
    const retainedManager = {
      context: { homeId, journalPath: "missing", recoveryBlockPath: "block" },
      recover: async () => {
        const turn = tryAdmitTurn();
        expect(turn).not.toBeNull();
        const selection = codexAccountSelectionForTurn(turn!)!();
        expect(selection?.mainProfileDraining).toBe(true);
        expect(selection?.claimMainProfile()).toBe(false);
        selection?.release();
        turn?.release();
        return { ok: true, recovered: false };
      },
    } as unknown as NativeProfileManager;
    const retainedRequest = new Request("http://localhost/api/native-main-profiles/recover", {
      method: "POST",
      body: JSON.stringify({ rollback: false }),
    });
    const retained = await handleNativeProfileAPI(retainedRequest, new URL(retainedRequest.url), {} as OcxConfig, {
      manager: retainedManager,
      probeRecoveryState: () => "manual",
      completeRecovery: () => { completions += 1; return true; },
    });
    expect(retained?.status).toBe(200);
    expect(completions).toBe(0);
    expect(nativeMainStartupGateSnapshot()).toMatchObject({ status: "blocked", homeId });

    const failedManager = {
      context: retainedManager.context,
      recover: async () => { throw new NativeProfileError("RECOVERY_REQUIRED", "marker retained", 409); },
    } as unknown as NativeProfileManager;
    const failedRequest = new Request("http://localhost/api/native-main-profiles/recover", {
      method: "POST",
      body: JSON.stringify({ rollback: false }),
    });
    const failed = await handleNativeProfileAPI(failedRequest, new URL(failedRequest.url), {} as OcxConfig, {
      manager: failedManager,
      probeRecoveryState: () => "manual",
      completeRecovery: () => { completions += 1; return true; },
    });
    expect(failed?.status).toBe(409);
    expect(completions).toBe(0);
  });

  test("a cleared recovery state cannot complete a startup gate for another home", async () => {
    await initializeNativeMainStartupGate({
      manager: { context: { homeId: "home-a" }, recover: async () => ({}) } as unknown as NativeProfileManager,
      probeRecoveryState: () => "manual",
    });
    const manager = {
      context: { homeId: "home-b", journalPath: "pending", recoveryBlockPath: "block" },
      recover: async () => ({ ok: true }),
    } as unknown as NativeProfileManager;
    const states = ["manual", "none"] as const;
    const request = new Request("http://localhost/api/native-main-profiles/recover", {
      method: "POST",
      body: JSON.stringify({ rollback: false }),
    });
    const response = await handleNativeProfileAPI(request, new URL(request.url), {} as OcxConfig, {
      manager,
      probeRecoveryState: () => states.shift() ?? "none",
    });
    expect(response?.status).toBe(200);
    expect(nativeMainStartupGateSnapshot()).toMatchObject({ status: "blocked", homeId: "home-a" });
  });

  test("unknown failures use a fixed redacted internal code while typed recovery remains distinct", async () => {
    const secret = "C:\\Users\\Private\\.codex\\auth.json bearer-secret";
    const manager = {
      list: async () => { throw new Error(secret); },
    } as unknown as NativeProfileManager;
    const request = new Request("http://localhost/api/native-main-profiles");
    const response = await handleNativeProfileAPI(request, new URL(request.url), {} as OcxConfig, { manager });
    expect(response?.status).toBe(500);
    const payload = await response?.json() as { code: string; error: string };
    expect(payload).toEqual({ code: "INTERNAL_ERROR", error: "Native-profile operation failed." });
    expect(JSON.stringify(payload)).not.toContain(secret);
  });
});
