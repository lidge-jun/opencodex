import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BridgeCoreError,
  parseChatGptConversationUrl,
} from "../../src/chatgpt-bridge/contracts";
import { BridgeBindingStore } from "../../src/chatgpt-bridge/core/store";
import { LegacyBindingRegistryReader } from "../../src/chatgpt-bridge/hosts/codex/legacy-registry";

const HOST = {
  kind: "codex",
  instanceId: "codex-desktop-local",
  targetId: "01987654-aaaa-7ccc-9ddd-eeeeeeeeeeee",
  workspaceRef: "g:/zcode-project/codex-chatgpt-web",
} as const;

const CHAT_URL = "https://chatgpt.com/c/12345678-90ab-4cde-8f01-234567890abc";

function makeStore(): BridgeBindingStore {
  const db = new Database(":memory:");
  return new BridgeBindingStore(db, { reservationStaleMs: 60_000, duplicateGuardMs: 60_000 });
}

function createBinding(store: BridgeBindingStore, chatUrl: string = CHAT_URL) {
  return store.createBinding({
    ownerRef: "owner:test",
    host: { ...HOST },
    chatUrl,
    operationId: crypto.randomUUID(),
  });
}

/** bun:test toThrow does not take predicates; assert code explicitly here. */
function expectBridgeError(fn: () => unknown, code: string) {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(BridgeCoreError);
  expect((caught as BridgeCoreError).code).toBe(code);
}

describe("chatgpt-bridge contracts", () => {
  test("parseChatGptConversationUrl accepts only normal-chat URLs", () => {
    expect(parseChatGptConversationUrl(CHAT_URL).conversationId).toBe("12345678-90ab-4cde-8f01-234567890abc");
    expectBridgeError(() => parseChatGptConversationUrl("http://chatgpt.com/c/12345678-90ab-4cde-8f01-234567890abc"), "INVALID_CHATGPT_URL");
    expectBridgeError(() => parseChatGptConversationUrl("https://chatgpt.com/share/abc"), "INVALID_CHATGPT_URL");
    expectBridgeError(() => parseChatGptConversationUrl("https://chatgpt.com/gpts/mine"), "INVALID_CHATGPT_URL");
  });
});

describe("chatgpt-bridge core store: management fencing", () => {
  test("revision conflict is rejected with BINDING_REVISION_CONFLICT", () => {
    const store = makeStore();
    const { binding } = createBinding(store);
    expectBridgeError(
      () =>
        store.manageBinding({
          bindingId: binding.bindingId,
          action: "pause",
          operationId: crypto.randomUUID(),
          expectedRevision: binding.revision + 5,
        }),
      "BINDING_REVISION_CONFLICT",
    );
  });

  test("same operationId replays original receipt; different request conflicts", () => {
    const store = makeStore();
    const operationId = crypto.randomUUID();
    const first = store.createBinding({ ownerRef: "owner:test", host: { ...HOST }, chatUrl: CHAT_URL, operationId });
    expect(first.receipt.outcome).toBe("applied");

    const replay = store.createBinding({ ownerRef: "owner:test", host: { ...HOST }, chatUrl: CHAT_URL, operationId });
    expect(replay.receipt.outcome).toBe("alreadyApplied");
    expect(replay.binding.bindingId).toBe(first.binding.bindingId);

    expectBridgeError(
      () =>
        store.createBinding({
          ownerRef: "owner:other",
          host: { ...HOST },
          chatUrl: "https://chatgpt.com/c/99999999-90ab-4cde-8f01-234567890abc",
          operationId,
        }),
      "OPERATION_ID_CONFLICT",
    );
  });

  test("pause/resume flow works, pause blocks sending with SEND_PAUSED", () => {
    const store = makeStore();
    const { binding } = createBinding(store);
    const paused = store.manageBinding({
      bindingId: binding.bindingId,
      action: "pause",
      operationId: crypto.randomUUID(),
      expectedRevision: binding.revision,
    });
    expect(paused.binding?.lifecycle).toBe("paused");
    expectBridgeError(
      () =>
        store.reserveDelivery({
          bindingId: binding.bindingId,
          operationId: crypto.randomUUID(),
          direction: "chat-to-host",
          sourceMessageId: "m1",
          prompt: "hello",
        }),
      "SEND_PAUSED",
    );
  });

  test("revoke bumps epoch and fences in-flight settlements", () => {
    const store = makeStore();
    const { binding } = createBinding(store);
    const reservation = store.reserveDelivery({
      bindingId: binding.bindingId,
      operationId: crypto.randomUUID(),
      direction: "chat-to-host",
      sourceMessageId: "m1",
      prompt: "work on this",
    });
    store.manageBinding({
      bindingId: binding.bindingId,
      action: "revoke",
      operationId: crypto.randomUUID(),
      expectedRevision: binding.revision,
    });
    const revoked = store.getBinding(binding.bindingId)!;
    expect(revoked.lifecycle).toBe("revoked");
    expect(revoked.epoch).toBe(binding.epoch + 1);
    expectBridgeError(
      () => store.settleDelivery({ reservationId: reservation.reservationId, outcome: "delivered" }),
      "BINDING_CHANGED",
    );
  });
});

describe("chatgpt-bridge core store: delivery guarantees", () => {
  test("delivered prompt inside guard window is rejected as DUPLICATE_PROMPT", () => {
    const store = makeStore();
    const { binding } = createBinding(store);
    const reservation = store.reserveDelivery({
      bindingId: binding.bindingId,
      operationId: crypto.randomUUID(),
      direction: "chat-to-host",
      sourceMessageId: "m1",
      prompt: "run the probe",
    });
    store.settleDelivery({ reservationId: reservation.reservationId, outcome: "delivered" });
    expectBridgeError(
      () =>
        store.reserveDelivery({
          bindingId: binding.bindingId,
          operationId: crypto.randomUUID(),
          direction: "chat-to-host",
          sourceMessageId: "m2",
          prompt: "run the probe",
        }),
      "DUPLICATE_PROMPT",
    );
  });

  test("unknown outcome blocks re-send until manually resolved; no auto resend path exists", () => {
    const store = makeStore();
    const { binding } = createBinding(store);
    const reservation = store.reserveDelivery({
      bindingId: binding.bindingId,
      operationId: crypto.randomUUID(),
      direction: "chat-to-host",
      sourceMessageId: "m1",
      prompt: "maybe sent",
    });
    store.settleDelivery({
      reservationId: reservation.reservationId,
      outcome: "unknown",
      operator: "owner:manual-check",
    });
    expectBridgeError(
      () =>
        store.reserveDelivery({
          bindingId: binding.bindingId,
          operationId: crypto.randomUUID(),
          direction: "chat-to-host",
          sourceMessageId: "m2",
          prompt: "retry after unknown",
        }),
      "DELIVERY_UNKNOWN",
    );

    const pending = store.pendingDelivery(binding.bindingId);
    expect(pending?.state).toBe("unknown");
  });

  test("settle not-delivered requires a definite non-delivery code", () => {
    const store = makeStore();
    const { binding } = createBinding(store);
    const reservation = store.reserveDelivery({
      bindingId: binding.bindingId,
      operationId: crypto.randomUUID(),
      direction: "chat-to-host",
      sourceMessageId: "m1",
      prompt: "definite check",
    });
    expectBridgeError(
      () => store.settleDelivery({ reservationId: reservation.reservationId, outcome: "not-delivered", failureCode: "PIPE_TIMEOUT" as never }),
      "DELIVERY_UNKNOWN",
    );
    const settled = store.settleDelivery({
      reservationId: reservation.reservationId,
      outcome: "not-delivered",
      failureCode: "EMPTY_PROMPT",
    });
    expect(settled.state).toBe("not-delivered");
  });
});

describe("chatgpt-bridge legacy registry federation", () => {
  test("reads v2 registry, projects fields, never writes the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "chatgpt-bridge-legacy-"));
    const path = join(dir, "bindings.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        managementRevision: 14,
        bindings: {
          "aaaaaaaa-1111-2222-3333-444444444444": {
            version: 1,
            bindingId: "aaaaaaaa-1111-2222-3333-444444444444",
            bindingEpoch: "epoch-uuid-1",
            revision: 3,
            active: true,
            paused: false,
            chatgptUrl: CHAT_URL,
            chatgptTitle: "retro",
            codexThreadId: "01987654-aaaa-7ccc-9ddd-eeeeeeeeeeee",
            codexDeepLink: "codex://threads/01987654-aaaa-7ccc-9ddd-eeeeeeeeeeee",
            capabilityExpiresAt: "2026-10-03T00:00:00.000Z",
            updatedAt: "2026-09-10T00:00:00.000Z",
            capabilityHash: "ab".repeat(32),
            operations: [],
          },
          "bbbbbbbb-1111-2222-3333-444444444444": {
            version: 1,
            bindingId: "bbbbbbbb-1111-2222-3333-444444444444",
            bindingEpoch: "epoch-uuid-2",
            revision: 1,
            active: false,
            paused: false,
            chatgptUrl: "https://chatgpt.com/share/junk",
            chatgptTitle: "share page",
            codexThreadId: null,
            codexDeepLink: null,
            capabilityExpiresAt: null,
            updatedAt: null,
          },
        },
      }),
      "utf8",
    );
    const before = statSync(path).mtimeMs;
    const bytesBefore = readFileSync(path);

    const reader = new LegacyBindingRegistryReader(path);
    const snapshot = reader.read();
    expect(snapshot.version).toBe(2);
    expect(snapshot.managementRevision).toBe(14);
    expect(snapshot.bindings).toHaveLength(2);
    const good = reader.get("AAAAAAAA-1111-2222-3333-444444444444");
    expect(good?.targetable).toBe(true);
    expect(good?.bindingEpoch).toBe("epoch-uuid-1");
    const share = reader.get("bbbbbbbb-1111-2222-3333-444444444444");
    expect(share?.targetable).toBe(false);

    expect(statSync(path).mtimeMs).toBe(before);
    expect(readFileSync(path).equals(bytesBefore)).toBe(true);
  });

  test("missing registry reads as empty without throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "chatgpt-bridge-legacy-"));
    const reader = new LegacyBindingRegistryReader(join(dir, "missing.json"));
    const snapshot = reader.read();
    expect(snapshot.bindings).toHaveLength(0);
  });

  test("mkdir on the state dir is never performed by the reader", () => {
    const dir = mkdtempSync(join(tmpdir(), "chatgpt-bridge-legacy-"));
    const nested = join(dir, "state", "chatgpt-codex-live-bridge");
    const reader = new LegacyBindingRegistryReader(join(nested, "bindings.json"));
    reader.read();
    let exists = false;
    try {
      statSync(nested);
      exists = true;
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });
});

describe("chatgpt-bridge store: legacy-only facts are not duplicated", () => {
  test("new store does not import or mutate legacy files (dual-write guard)", () => {
    const dir = mkdtempSync(join(tmpdir(), "chatgpt-bridge-legacy-"));
    mkdirSync(join(dir, "controllers"), { recursive: true });
    const path = join(dir, "bindings.json");
    writeFileSync(
      path,
      JSON.stringify({ version: 2, managementRevision: 1, bindings: {} }),
      "utf8",
    );
    const bytesBefore = readFileSync(path);

    const store = makeStore();
    createBinding(store, CHAT_URL);
    const snapshot = new LegacyBindingRegistryReader(path).read();
    expect(snapshot.bindings).toHaveLength(0);
    expect(readFileSync(path).equals(bytesBefore)).toBe(true);
  });
});
