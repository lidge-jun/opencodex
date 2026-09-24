import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  BridgeCoreError,
  type BridgeBinding,
  type BridgeDeliveryState,
  type BridgeLifecycle,
  type BridgeManagementAction,
  type OperationReceipt,
  parseChatGptConversationUrl,
  DEFINITE_NON_DELIVERY_CODES,
  type BridgeErrorCode,
  MAX_PROMPT_CHARS,
} from "../contracts";

/**
 * Durations follow the conservative boundaries validated by the legacy bridge
 * (bridge-lib.mjs): a pending send older than the reservation window must be
 * treated as outcome-unknown, and repeating an identical prompt inside the
 * duplicate guard window is rejected instead of re-sent.
 */
const RESERVATION_STALE_MS = 120_000;
const DUPLICATE_GUARD_MS = 120_000;
const MAX_OPERATIONS_PER_BINDING = 40;
// Age-free ceiling, so a wrong clock at install cannot make the table grow forever.
const MAX_OPERATIONS_HARD_CAP = 400;
// A dashboard reload replays the pending action minutes later, so a receipt must stay
// replayable longer than the send path's own stale window.
const OPERATION_REPLAY_MS = 15 * 60_000;

export interface CreateBindingInput {
  bindingId?: string;
  ownerRef: string;
  host: BridgeBinding["host"];
  chatUrl: string;
  capabilityHash?: string | null;
  capabilityExpiresAt?: string | null;
  operationId: string;
  expectedRegistryRevision?: number;
}

export interface ManageBindingInput {
  bindingId: string;
  action: Exclude<BridgeManagementAction, "create">;
  operationId: string;
  expectedRevision: number;
  capabilityHash?: string | null;
  capabilityExpiresAt?: string | null;
}

export interface ReserveDeliveryInput {
  bindingId: string;
  operationId: string;
  direction: "host-to-chat" | "chat-to-host";
  sourceMessageId: string;
  prompt: string;
}

export interface DeliveryReservation {
  reservationId: string;
  bindingId: string;
  bindingEpoch: number;
  state: BridgeDeliveryState;
  reservedAt: string;
}

export interface SettleDeliveryInput {
  reservationId: string;
  /** Explicit caller decision; "unknown" must never be downgraded automatically. */
  outcome: "delivered" | "not-delivered" | "unknown";
  failureCode?: BridgeErrorCode;
  receiptId?: string;
  operator?: string;
}

const now = () => new Date().toISOString();

/**
 * Durable binding store. Single writer, versioned schema, no message bodies:
 * only digests, ids, receipts, and lifecycle facts live here.
 */
export class BridgeBindingStore {
  private readonly db: Database;

  constructor(
    database: Database | string,
    private readonly options: { reservationStaleMs?: number; duplicateGuardMs?: number } = {},
  ) {
    this.db = typeof database === "string" ? new Database(database) : database;
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chatgpt_bridge_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chatgpt_bridge_bindings (
        binding_id TEXT PRIMARY KEY,
        host_kind TEXT NOT NULL,
        host_instance_id TEXT NOT NULL,
        host_target_id TEXT NOT NULL,
        host_workspace_ref TEXT NOT NULL,
        chat_conversation_id TEXT NOT NULL UNIQUE,
        chat_canonical_url TEXT NOT NULL,
        owner_ref TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_locator TEXT NOT NULL,
        revision INTEGER NOT NULL,
        epoch INTEGER NOT NULL,
        lifecycle TEXT NOT NULL,
        attachment_state TEXT NOT NULL,
        capability_hash TEXT,
        capability_expires_at TEXT,
        proof_attachment TEXT,
        proof_host_read TEXT,
        proof_chat_read TEXT,
        proof_checked_at TEXT,
        last_receipt_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chatgpt_bridge_operations (
        operation_id TEXT PRIMARY KEY,
        binding_id TEXT NOT NULL,
        action TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        revision INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        error_code TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chatgpt_bridge_deliveries (
        reservation_id TEXT PRIMARY KEY,
        binding_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        source_message_id TEXT NOT NULL,
        prompt_digest TEXT NOT NULL,
        binding_epoch INTEGER NOT NULL,
        state TEXT NOT NULL,
        failure_code TEXT,
        receipt_id TEXT,
        resolved_by TEXT,
        reserved_at TEXT NOT NULL,
        settled_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_bridge_deliveries_binding ON chatgpt_bridge_deliveries(binding_id, state);
      CREATE INDEX IF NOT EXISTS idx_bridge_deliveries_digest ON chatgpt_bridge_deliveries(binding_id, prompt_digest, state);
      -- The chat side is UNIQUE in schema; the host side was only checked in-process,
      -- so a second process on this file could bind one Codex target twice.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_bridge_bindings_host_target
        ON chatgpt_bridge_bindings(host_instance_id, host_target_id)
        WHERE lifecycle IN ('active', 'paused');
    `);
    this.db
      .prepare(
        "INSERT INTO chatgpt_bridge_meta(key, value) VALUES('schema_version', '1') ON CONFLICT(key) DO NOTHING",
      )
      .run();
  }

  close(): void {
    this.db.close();
  }

  /** Every multi-statement write below runs in one transaction: a receipt must not outlive its row. */
  private tx<T>(write: () => T): T {
    return this.db.transaction(write)();
  }

  private rowToBinding(row: Record<string, unknown>): BridgeBinding {
    return {
      schemaVersion: 1,
      bindingId: row.binding_id as string,
      ownerRef: row.owner_ref as string,
      host: {
        kind: row.host_kind as BridgeBinding["host"]["kind"],
        instanceId: row.host_instance_id as string,
        targetId: row.host_target_id as string,
        workspaceRef: row.host_workspace_ref as string,
      },
      chat: {
        conversationId: row.chat_conversation_id as string,
        canonicalUrl: row.chat_canonical_url as string,
        kind: "normal-chat",
      },
      source: {
        kind: row.source_kind as BridgeBinding["source"]["kind"],
        locator: row.source_locator as string,
      },
      revision: row.revision as number,
      epoch: row.epoch as number,
      lifecycle: row.lifecycle as BridgeLifecycle,
      attachmentState: row.attachment_state as BridgeBinding["attachmentState"],
      capabilityHash: (row.capability_hash as string) ?? null,
      capabilityExpiresAt: (row.capability_expires_at as string) ?? null,
      proof: {
        attachment: (row.proof_attachment as string) ?? null,
        hostRead: (row.proof_host_read as string) ?? null,
        chatRead: (row.proof_chat_read as string) ?? null,
        checkedAt: (row.proof_checked_at as string) ?? null,
      },
      lastReceiptId: (row.last_receipt_id as string) ?? null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  private fetchBindingRow(bindingId: string): Record<string, unknown> | null {
    return (
      (this.db.prepare("SELECT * FROM chatgpt_bridge_bindings WHERE binding_id = ?").get(bindingId) as
        | Record<string, unknown>
        | null) ?? null
    );
  }

  getBinding(bindingId: string): BridgeBinding | null {
    const row = this.fetchBindingRow(bindingId);
    return row ? this.rowToBinding(row) : null;
  }

  listBindings(): BridgeBinding[] {
    const rows = this.db
      .prepare("SELECT * FROM chatgpt_bridge_bindings ORDER BY created_at")
      .all() as Record<string, unknown>[];
    return rows.map(row => this.rowToBinding(row));
  }

  getOperation(operationId: string): (OperationReceipt & { requestDigest: string }) | null {
    const row = this.db
      .prepare("SELECT * FROM chatgpt_bridge_operations WHERE operation_id = ?")
      .get(operationId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      operationId: row.operation_id as string,
      bindingId: row.binding_id as string,
      action: row.action as BridgeManagementAction,
      requestDigest: row.request_digest as string,
      revision: row.revision as number,
      outcome: row.outcome as OperationReceipt["outcome"],
      errorCode: (row.error_code as BridgeErrorCode) ?? undefined,
      createdAt: row.created_at as string,
    };
  }

  private recordOperation(
    operationId: string,
    bindingId: string,
    action: BridgeManagementAction,
    requestDigest: string,
    revision: number,
    outcome: OperationReceipt["outcome"],
    errorCode?: BridgeErrorCode,
  ): OperationReceipt {
    const created = now();
    this.db
      .prepare(
        `INSERT INTO chatgpt_bridge_operations
         (operation_id, binding_id, action, request_digest, revision, outcome, error_code, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(operationId, bindingId, action, requestDigest, revision, outcome, errorCode ?? null, created);
    this.pruneOperations(bindingId);
    return { operationId, bindingId, action, revision, outcome, errorCode, createdAt: created };
  }

  /**
   * Trim each binding's receipt history, but never inside the replay window: a
   * pruned row turns a late retry of `create` into a second insert (or a
   * `BINDING_EXISTS`) instead of the `alreadyApplied` replay it asked for.
   *
   * The age condition can be defeated by the clock: a device that booted with a wrong
   * RTC writes future `created_at` values that never age out, so the second statement
   * is an age-free backstop. Growth is then `MAX_OPERATIONS_PER_BINDING` in steady
   * state and never more than `MAX_OPERATIONS_HARD_CAP` even with a hostile clock.
   */
  private pruneOperations(bindingId: string): void {
    const cutoff = new Date(Date.now() - OPERATION_REPLAY_MS).toISOString();
    this.db
      .prepare(
        `DELETE FROM chatgpt_bridge_operations WHERE binding_id = ? AND created_at < ? AND operation_id NOT IN (
           SELECT operation_id FROM chatgpt_bridge_operations WHERE binding_id = ?
           ORDER BY created_at DESC LIMIT ?
         )`,
      )
      .run(bindingId, cutoff, bindingId, MAX_OPERATIONS_PER_BINDING);
    this.db
      .prepare(
        `DELETE FROM chatgpt_bridge_operations WHERE binding_id = ? AND operation_id NOT IN (
           SELECT operation_id FROM chatgpt_bridge_operations WHERE binding_id = ?
           ORDER BY created_at DESC LIMIT ?
         )`,
      )
      .run(bindingId, bindingId, MAX_OPERATIONS_HARD_CAP);
  }

  private assertOperationIdempotent(
    operationId: string,
    action: BridgeManagementAction,
    requestDigest: string,
  ): OperationReceipt | null {
    const existing = this.getOperation(operationId);
    if (!existing) return null;
    if (existing.requestDigest !== requestDigest || existing.action !== action) {
      throw new BridgeCoreError("OPERATION_ID_CONFLICT", `operationId reused with a different request`);
    }
    return {
      operationId,
      bindingId: existing.bindingId,
      action: existing.action,
      revision: existing.revision,
      outcome: "alreadyApplied",
      errorCode: existing.errorCode,
      createdAt: existing.createdAt,
    };
  }

  createBinding(input: CreateBindingInput): { binding: BridgeBinding; receipt: OperationReceipt } {
    const chat = parseChatGptConversationUrl(input.chatUrl);
    const digest = JSON.stringify({
      ownerRef: input.ownerRef,
      host: input.host,
      chat,
      capabilityHash: input.capabilityHash ?? null,
    });
    const replay = this.assertOperationIdempotent(input.operationId, "create", digest);
    if (replay) {
      const existing = this.getBinding(replay.bindingId);
      if (existing) return { binding: existing, receipt: replay };
      throw new BridgeCoreError("OPERATION_ID_CONFLICT", "create receipt has no binding");
    }

    const bindingId = input.bindingId ?? randomUUID();
    if (this.getBinding(bindingId)) {
      throw new BridgeCoreError("BINDING_EXISTS", "bindingId already exists");
    }
    const duplicateChat = this.db
      .prepare("SELECT binding_id FROM chatgpt_bridge_bindings WHERE chat_conversation_id = ?")
      .get(chat.conversationId) as { binding_id: string } | undefined;
    if (duplicateChat) {
      throw new BridgeCoreError("BINDING_EXISTS", "chat already bound to another target");
    }
    // The mirror of the chat guard: two bindings on one host target would both
    // deliver into the same task, and the per-binding SEND_IN_PROGRESS and
    // DUPLICATE_PROMPT guards cannot see each other across them.
    const duplicateHost = this.db
      .prepare(
        "SELECT binding_id FROM chatgpt_bridge_bindings WHERE host_instance_id = ? AND host_target_id = ? AND lifecycle IN ('active','paused')",
      )
      .get(input.host.instanceId, input.host.targetId) as { binding_id: string } | undefined;
    if (duplicateHost) {
      throw new BridgeCoreError("BINDING_EXISTS", "host target already bound to another chat");
    }

    const created = now();
    const binding: BridgeBinding = {
      schemaVersion: 1,
      bindingId,
      ownerRef: input.ownerRef,
      host: input.host,
      chat: { ...chat, kind: "normal-chat" },
      source: { kind: "bridge-v1", locator: `bridge:${bindingId}` },
      revision: 0,
      epoch: 0,
      lifecycle: "active",
      attachmentState: "pending",
      capabilityHash: input.capabilityHash ?? null,
      capabilityExpiresAt: input.capabilityExpiresAt ?? null,
      proof: { attachment: null, hostRead: null, chatRead: null, checkedAt: null },
      lastReceiptId: null,
      createdAt: created,
      updatedAt: created,
    };
    const receipt = this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO chatgpt_bridge_bindings
           (binding_id, host_kind, host_instance_id, host_target_id, host_workspace_ref,
            chat_conversation_id, chat_canonical_url, owner_ref, source_kind, source_locator,
            revision, epoch, lifecycle, attachment_state, capability_hash, capability_expires_at,
            proof_attachment, proof_host_read, proof_chat_read, proof_checked_at, last_receipt_id,
            created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'bridge-v1', ?, 0, 0, 'active', 'pending', ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
        )
        .run(
          binding.bindingId,
          binding.host.kind,
          binding.host.instanceId,
          binding.host.targetId,
          binding.host.workspaceRef,
          binding.chat.conversationId,
          binding.chat.canonicalUrl,
          binding.ownerRef,
          binding.source.locator,
          binding.capabilityHash,
          binding.capabilityExpiresAt,
          binding.createdAt,
          binding.updatedAt,
        );
      return this.recordOperation(input.operationId, bindingId, "create", digest, 0, "applied");
    });
    return { binding, receipt };
  }

  attachBinding(
    bindingId: string,
    input: { operationId: string; expectedRevision: number; attachmentProof: string },
  ): { binding: BridgeBinding; receipt: OperationReceipt } {
    const digest = JSON.stringify({ bindingId, attachmentProof: input.attachmentProof });
    const replay = this.assertOperationIdempotent(input.operationId, "attach", digest);
    if (replay) {
      const existing = this.getBinding(bindingId);
      if (!existing) throw new BridgeCoreError("BINDING_NOT_FOUND", bindingId);
      return { binding: existing, receipt: replay };
    }
    const binding = this.getBinding(bindingId);
    if (!binding) throw new BridgeCoreError("BINDING_NOT_FOUND", bindingId);
    if (binding.revision !== input.expectedRevision) {
      throw new BridgeCoreError("BINDING_REVISION_CONFLICT", "expectedRevision does not match", {
        expected: input.expectedRevision,
        current: binding.revision,
      });
    }
    const updated = now();
    const nextState: BridgeBinding["attachmentState"] =
      binding.attachmentState === "readable" ? "readable" : "attached";
    const receipt = this.tx(() => {
      this.db
        .prepare(
          `UPDATE chatgpt_bridge_bindings SET attachment_state = ?, proof_attachment = ?,
           revision = revision + 1, updated_at = ? WHERE binding_id = ?`,
        )
        .run(nextState, input.attachmentProof, updated, bindingId);
      return this.recordOperation(input.operationId, bindingId, "attach", digest, binding.revision + 1, "applied");
    });
    return { binding: this.getBinding(bindingId)!, receipt };
  }

  manageBinding(input: ManageBindingInput): { binding: BridgeBinding | null; receipt: OperationReceipt } {
    const digest = JSON.stringify({
      bindingId: input.bindingId,
      action: input.action,
      capabilityHash: input.capabilityHash ?? null,
    });
    const replay = this.assertOperationIdempotent(input.operationId, input.action, digest);
    if (replay) {
      return { binding: this.getBinding(input.bindingId), receipt: replay };
    }
    const binding = this.getBinding(input.bindingId);
    if (!binding) throw new BridgeCoreError("BINDING_NOT_FOUND", input.bindingId);
    if (binding.revision !== input.expectedRevision) {
      throw new BridgeCoreError("BINDING_REVISION_CONFLICT", "expectedRevision does not match", {
        expected: input.expectedRevision,
        current: binding.revision,
      });
    }

    const lifecycle = binding.lifecycle;
    const nextLifecycle: BridgeLifecycle | null = (() => {
      switch (input.action) {
        case "pause":
          return lifecycle === "active" ? "paused" : null;
        case "resume":
          return lifecycle === "paused" ? "active" : null;
        case "revoke":
          return lifecycle === "active" || lifecycle === "paused" ? "revoked" : null;
        case "unbind":
          return lifecycle === "revoked" || lifecycle === "active" || lifecycle === "paused" ? "unbound" : null;
        case "renew":
          return lifecycle === "active" || lifecycle === "paused" ? lifecycle : null;
        default:
          return null;
      }
    })();
    if (nextLifecycle === null) {
      throw new BridgeCoreError("BINDING_REVISION_CONFLICT", `action ${input.action} invalid in lifecycle ${lifecycle}`);
    }

    const updated = now();
    const epochBump = input.action === "revoke" ? 1 : 0;
    const receipt = this.tx(() => {
      this.db
        .prepare(
          `UPDATE chatgpt_bridge_bindings SET lifecycle = ?, epoch = epoch + ?,
           revision = revision + 1,
           capability_hash = COALESCE(?, capability_hash),
           capability_expires_at = COALESCE(?, capability_expires_at),
           updated_at = ? WHERE binding_id = ?`,
        )
        .run(
          nextLifecycle,
          epochBump,
          input.capabilityHash ?? null,
          input.capabilityExpiresAt ?? null,
          updated,
          input.bindingId,
        );
      return this.recordOperation(
        input.operationId,
        input.bindingId,
        input.action,
        digest,
        binding.revision + 1,
        "applied",
      );
    });
    return { binding: this.getBinding(input.bindingId), receipt };
  }

  reserveDelivery(input: ReserveDeliveryInput): DeliveryReservation {
    const binding = this.getBinding(input.bindingId);
    if (!binding) throw new BridgeCoreError("BINDING_NOT_FOUND", input.bindingId);
    if (binding.lifecycle === "paused") throw new BridgeCoreError("SEND_PAUSED", "binding is paused");
    if (binding.lifecycle === "revoked" || binding.lifecycle === "unbound") {
      throw new BridgeCoreError("CAPABILITY_REVOKED", `binding is ${binding.lifecycle}`);
    }
    const prompt = input.prompt;
    if (prompt.length === 0) throw new BridgeCoreError("EMPTY_PROMPT", "prompt is empty");
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new BridgeCoreError("PROMPT_TOO_LARGE", `prompt exceeds ${MAX_PROMPT_CHARS} characters`);
    }
    if (binding.attachmentState === "pending") {
      throw new BridgeCoreError("ATTACHMENT_REQUIRED", "binding has no attachment proof yet");
    }
    if (binding.capabilityExpiresAt && Date.parse(binding.capabilityExpiresAt) <= Date.now()) {
      throw new BridgeCoreError("CAPABILITY_EXPIRED", "capability expired before this send");
    }

    const pending = this.db
      .prepare(
        "SELECT * FROM chatgpt_bridge_deliveries WHERE binding_id = ? AND state IN ('reserved','unknown') ORDER BY reserved_at DESC LIMIT 1",
      )
      .get(input.bindingId) as Record<string, unknown> | undefined;
    if (pending) {
      const reservedAt = Date.parse(pending.reserved_at as string);
      const stale = Date.now() - reservedAt > (this.options.reservationStaleMs ?? RESERVATION_STALE_MS);
      if (pending.state === "unknown" || (pending.state === "reserved" && stale)) {
        if (pending.state === "reserved") {
          this.db
            .prepare("UPDATE chatgpt_bridge_deliveries SET state = 'unknown', settled_at = ? WHERE reservation_id = ?")
            .run(now(), pending.reservation_id as string);
        }
        throw new BridgeCoreError("DELIVERY_UNKNOWN", "prior send outcome unknown; reconcile before sending again", {
          reservationId: pending.reservation_id as string,
        });
      }
      throw new BridgeCoreError("SEND_IN_PROGRESS", "another send is pending on this binding", {
        reservationId: pending.reservation_id as string,
      });
    }

    const duplicate = this.db
      .prepare(
        "SELECT reservation_id, reserved_at FROM chatgpt_bridge_deliveries WHERE binding_id = ? AND prompt_digest = ? AND state = 'delivered' ORDER BY reserved_at DESC LIMIT 1",
      )
      .get(input.bindingId, sha256(prompt)) as Record<string, unknown> | undefined;
    if (duplicate && Date.now() - Date.parse(duplicate.reserved_at as string) < (this.options.duplicateGuardMs ?? DUPLICATE_GUARD_MS)) {
      throw new BridgeCoreError("DUPLICATE_PROMPT", "identical prompt delivered within the guard window");
    }

    const reservationId = randomUUID();
    const reservedAt = now();
    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO chatgpt_bridge_deliveries
           (reservation_id, binding_id, operation_id, direction, source_message_id, prompt_digest,
            binding_epoch, state, reserved_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?)`,
        )
        .run(
          reservationId,
          input.bindingId,
          input.operationId,
          input.direction,
          input.sourceMessageId,
          sha256(prompt),
          binding.epoch,
          reservedAt,
        );
      this.pruneDeliveries(input.bindingId);
    });
    return {
      reservationId,
      bindingId: input.bindingId,
      bindingEpoch: binding.epoch,
      state: "reserved",
      reservedAt,
    };
  }

  /**
   * Terminal rows older than the duplicate-guard window are invisible to every
   * reader by construction — the guard only looks inside the window, and a
   * reserved or unknown row is a fence that must survive until reconciled.
   */
  private pruneDeliveries(bindingId: string): void {
    const cutoff = new Date(Date.now() - (this.options.duplicateGuardMs ?? DUPLICATE_GUARD_MS)).toISOString();
    this.db
      .prepare(
        "DELETE FROM chatgpt_bridge_deliveries WHERE binding_id = ? AND state IN ('delivered','not-delivered') AND settled_at < ?",
      )
      .run(bindingId, cutoff);
  }

  settleDelivery(input: SettleDeliveryInput): { state: BridgeDeliveryState; receiptId: string | null } {
    const row = this.db
      .prepare("SELECT * FROM chatgpt_bridge_deliveries WHERE reservation_id = ?")
      .get(input.reservationId) as Record<string, unknown> | undefined;
    if (!row) throw new BridgeCoreError("TARGET_NOT_FOUND", `unknown reservation ${input.reservationId}`);
    if (row.state !== "reserved") {
      throw new BridgeCoreError("DELIVERY_UNKNOWN", `reservation already settled as ${row.state}`);
    }
    const binding = this.getBinding(row.binding_id as string);
    if (!binding || binding.epoch !== (row.binding_epoch as number)) {
      throw new BridgeCoreError("BINDING_CHANGED", "binding epoch changed since reservation");
    }
    if (input.outcome === "not-delivered") {
      if (!input.failureCode || !DEFINITE_NON_DELIVERY_CODES.includes(input.failureCode)) {
        throw new BridgeCoreError("DELIVERY_UNKNOWN", `${input.failureCode ?? "no code"} is not a definite non-delivery`);
      }
    }
    if (input.outcome === "unknown" && !input.operator) {
      throw new BridgeCoreError("DELIVERY_UNKNOWN", "manual unknown resolution requires operator identity");
    }
    // A receipt attests delivery: a not-delivered or unknown settlement records
    // a failure code, never a receipt the caller could present as proof.
    const receiptId = input.outcome === "delivered" ? input.receiptId ?? randomUUID() : null;
    const settledAt = now();
    this.tx(() => {
      this.db
        .prepare(
          "UPDATE chatgpt_bridge_deliveries SET state = ?, failure_code = ?, receipt_id = ?, resolved_by = ?, settled_at = ? WHERE reservation_id = ?",
        )
        .run(input.outcome, input.failureCode ?? null, receiptId, input.operator ?? null, settledAt, input.reservationId);
      if (receiptId) {
        this.db
          .prepare("UPDATE chatgpt_bridge_bindings SET last_receipt_id = ?, updated_at = ? WHERE binding_id = ?")
          .run(receiptId, settledAt, row.binding_id as string);
      }
    });
    return { state: input.outcome, receiptId };
  }

  pendingDelivery(bindingId: string): { reservationId: string; state: BridgeDeliveryState } | null {
    const row = this.db
      .prepare(
        "SELECT reservation_id, state FROM chatgpt_bridge_deliveries WHERE binding_id = ? AND state IN ('reserved','unknown') ORDER BY reserved_at DESC LIMIT 1",
      )
      .get(bindingId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return { reservationId: row.reservation_id as string, state: row.state as BridgeDeliveryState };
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
