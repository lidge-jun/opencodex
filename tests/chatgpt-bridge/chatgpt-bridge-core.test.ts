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
  const created = store.createBinding({
    ownerRef: "owner:test",
    host: { ...HOST },
    chatUrl,
    operationId: crypto.randomUUID(),
  });
  // A binding has to be attached before it can carry a prompt, so the shared
  // helper returns the state a delivery test actually starts from.
  return store.attachBinding(created.binding.bindingId, {
    operationId: crypto.randomUUID(),
    expectedRevision: created.binding.revision,
    attachmentProof: "proof:test",
  });
}

function reserve(store: BridgeBindingStore, bindingId: string, prompt: string) {
  return store.reserveDelivery({
    bindingId,
    operationId: crypto.randomUUID(),
    direction: "chat-to-host",
    sourceMessageId: "m1",
    prompt,
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

  test("receipt pruning keeps the replay window and still bounds the table", () => {
    const db = new Database(":memory:");
    const store = new BridgeBindingStore(db, { reservationStaleMs: 60_000, duplicateGuardMs: 60_000 });
    const chatUrl = "https://chatgpt.com/c/22222222-90ab-4cde-8f01-234567890abc";
    const createOp = crypto.randomUUID();
    const input = { ownerRef: "owner:prune", host: { ...HOST }, chatUrl, operationId: createOp };
    const created = store.createBinding(input);
    let revision = created.binding.revision;
    for (let i = 0; i < 45; i += 1) {
      const again = store.attachBinding(created.binding.bindingId, {
        operationId: crypto.randomUUID(),
        expectedRevision: revision,
        attachmentProof: `proof:${i}`,
      });
      revision = again.binding.revision;
    }
    // 45 newer receipts have passed the newest-40 window over the create row. A
    // late retry must still replay it, not run the create a second time.
    expect(store.createBinding(input).receipt.outcome).toBe("alreadyApplied");

    const rowCount = () =>
      (db.query("SELECT COUNT(*) AS n FROM chatgpt_bridge_operations").get() as { n: number }).n;
    expect(rowCount()).toBe(46);

    // Outside the window the same trim must actually delete, or the table is unbounded.
    // The create row itself stays inside the window, so which rows get trimmed is
    // deterministic despite the shared backdated timestamp.
    db.run("UPDATE chatgpt_bridge_operations SET created_at = '2020-01-01T00:00:00.000Z' WHERE operation_id != ?", [createOp]);
    store.attachBinding(created.binding.bindingId, {
      operationId: crypto.randomUUID(),
      expectedRevision: revision,
      attachmentProof: "proof:after-backdate",
    });
    expect(rowCount()).toBe(40);
    expect(store.getOperation(createOp)?.action).toBe("create");
  });

  test("the replay window is pinned from both sides, not just present", () => {
    const db = new Database(":memory:");
    const store = new BridgeBindingStore(db, { reservationStaleMs: 60_000, duplicateGuardMs: 60_000 });
    const chatUrl = "https://chatgpt.com/c/33333333-90ab-4cde-8f01-234567890abc";
    const createOp = crypto.randomUUID();
    const created = store.createBinding({ ownerRef: "owner:window", host: { ...HOST }, chatUrl, operationId: createOp });
    let revision = created.binding.revision;
    const attachOps: string[] = [];
    for (let i = 0; i < 45; i += 1) {
      const operationId = crypto.randomUUID();
      attachOps.push(operationId);
      revision = store.attachBinding(created.binding.bindingId, {
        operationId, expectedRevision: revision, attachmentProof: `proof:${i}`,
      }).binding.revision;
    }
    const aged = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
    const backdate = (operationId: string, minutesAgo: number) =>
      db.run("UPDATE chatgpt_bridge_operations SET created_at = ? WHERE operation_id = ?", [aged(minutesAgo), operationId]);
    // Both are older than the newest 40 receipts, so the age floor is the only thing
    // that can keep the 14-minute one. The 16-minute one has to go, or the window is
    // longer than the receipts a client can still be retrying inside.
    backdate(createOp, 14);
    backdate(attachOps[0], 16);
    store.attachBinding(created.binding.bindingId, {
      operationId: crypto.randomUUID(), expectedRevision: revision, attachmentProof: "proof:trigger",
    });

    expect(store.getOperation(createOp)).not.toBeNull();
    expect(store.getOperation(attachOps[0])).toBeNull();
    expect((db.query("SELECT COUNT(*) AS n FROM chatgpt_bridge_operations").get() as { n: number }).n).toBe(46);
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
    const reservation = reserve(store, binding.bindingId, "definite check");
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

  test("a settlement that did not deliver records no receipt", () => {
    const store = makeStore();
    const { binding } = createBinding(store);
    const notDelivered = store.settleDelivery({
      reservationId: reserve(store, binding.bindingId, "never arrived").reservationId,
      outcome: "not-delivered",
      failureCode: "SEND_PAUSED",
    });
    expect(notDelivered.receiptId).toBeNull();
    expect(store.getBinding(binding.bindingId)?.lastReceiptId).toBeNull();
    const delivered = store.settleDelivery({
      reservationId: reserve(store, binding.bindingId, "arrived").reservationId,
      outcome: "delivered",
    });
    expect(delivered.receiptId).not.toBeNull();
    expect(store.getBinding(binding.bindingId)?.lastReceiptId).toBe(delivered.receiptId);
  });

  test("reserve enforces the attachment, capability and size gates", () => {
    const store = makeStore();
    const pending = store.createBinding({
      ownerRef: "owner:test",
      host: { ...HOST },
      chatUrl: CHAT_URL,
      operationId: crypto.randomUUID(),
    });
    expectBridgeError(() => reserve(store, pending.binding.bindingId, "too early"), "ATTACHMENT_REQUIRED");

    // A second store: one live binding per host target and per chat is the
    // invariant under test elsewhere, so the gated binding needs its own pair.
    const gated = makeStore();
    const { binding } = createBinding(gated);
    gated.manageBinding({
      bindingId: binding.bindingId,
      action: "renew",
      operationId: crypto.randomUUID(),
      expectedRevision: binding.revision,
      capabilityExpiresAt: "2020-01-01T00:00:00.000Z",
    });
    expectBridgeError(() => reserve(gated, binding.bindingId, "after expiry"), "CAPABILITY_EXPIRED");
    expectBridgeError(
      () => reserve(gated, binding.bindingId, "x".repeat(512 * 1024 + 1)),
      "PROMPT_TOO_LARGE",
    );
  });

  test("one host target and one chat each hold at most one live binding", () => {
    const store = makeStore();
    createBinding(store);
    expectBridgeError(
      () => store.createBinding({
        ownerRef: "owner:test",
        host: { ...HOST },
        chatUrl: "https://chatgpt.com/c/99999999-90ab-4cde-8f01-234567890abc",
        operationId: crypto.randomUUID(),
      }),
      "BINDING_EXISTS",
    );
    const otherTarget = store.createBinding({
      ownerRef: "owner:test",
      host: { ...HOST, targetId: "01987654-aaaa-7ccc-9ddd-ffffffffffff" },
      chatUrl: "https://chatgpt.com/c/99999999-90ab-4cde-8f01-234567890abc",
      operationId: crypto.randomUUID(),
    });
    expect(otherTarget.binding.bindingId).toBeDefined();
    // The create above leaves that chat conversation bound to the second target, so
    // this is the only call that reaches the chat guard: the host guard cannot fire here
    // (fresh targetId) and the operation replay cannot (fresh operationId).
    expectBridgeError(
      () => store.createBinding({
        ownerRef: "owner:test",
        host: { ...HOST, targetId: "01987654-bbbb-7ccc-9ddd-eeeeeeeeeeee" },
        chatUrl: "https://chatgpt.com/c/99999999-90ab-4cde-8f01-234567890abc",
        operationId: crypto.randomUUID(),
      }),
      "BINDING_EXISTS",
    );
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
