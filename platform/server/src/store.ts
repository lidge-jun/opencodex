import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify } from "node:crypto";
import type { PoolClient } from "pg";
import type { Database } from "./db";
import type { PlatformConfig } from "./config";
import {
  decryptSecret,
  encryptSecret,
  issueOpaqueToken,
  issueShortCode,
  networkSignalHmac,
  sha256,
} from "./security";

export type InstanceStatus =
  | "pending" | "provisioning" | "awaiting_agent" | "connecting" | "online"
  | "degraded" | "offline" | "suspending" | "suspended" | "deleting"
  | "delete_failed" | "deleted";

export interface Actor {
  id: string;
  githubNumericId: string;
  role: "user" | "admin";
  status: "active" | "pending_invite" | "suspended";
  name: string;
  email: string;
}

export interface DeviceAuthorizationDisplay {
  id: string;
  userCode: string;
  deviceName: string;
  platform: string;
  expiresAt: string;
  status: "pending" | "approved" | "expired" | "consumed";
}

export interface RemoteDeviceActor {
  actor: Actor;
  deviceId: string;
}

export interface RelayDeviceActor extends RemoteDeviceActor {
  instanceId: string | null;
  name: string;
  signingPublicKey: Buffer;
  ecdhPublicKey: Buffer;
}

export interface TerminalSessionRecord {
  id: string;
  instanceId: string;
  deviceId: string;
  userId: string;
  commandProfile: "shell" | "codex" | "claude";
  expiresAt: string;
}

export interface InstanceRecord {
  id: string;
  ownerId: string;
  name: string;
  slug: string;
  privateHostname: string;
  transportMode: "mesh-tunnel" | "outbound-relay";
  status: InstanceStatus;
  createdAt: string;
  updatedAt: string;
}

export interface RemoteProfile {
  passwordSet: boolean;
  canActivate: boolean;
  instance: (InstanceRecord & { publicUrl: string }) | null;
  e2ee: RemoteE2eeEnvelopeRecord | null;
  devices: RemoteDeviceRecord[];
}

export interface RemoteE2eeEnvelopeRecord {
  version: "ocx-e2ee-v1";
  salt: string;
  nonce: string;
  ciphertext: string;
  rootPublicKey: string;
  kdf: {
    algorithm: "argon2id";
    memoryKiB: number;
    iterations: number;
    parallelism: number;
    outputLength: 32;
  };
}

export interface RemoteDeviceRecord {
  id: string;
  name: string;
  platform: string;
  signingPublicKey: string;
  ecdhPublicKey: string | null;
  relayOnline: boolean;
  lastSeenAt: string | null;
  instanceId: string | null;
}

interface InstanceRow {
  id: string;
  owner_id: string;
  name: string;
  slug: string;
  private_hostname: string;
  private_origin_ip: string;
  transport_mode: "mesh-tunnel" | "outbound-relay";
  status: InstanceStatus;
  created_at: Date;
  updated_at: Date;
}

function instanceFromRow(row: InstanceRow): InstanceRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    slug: row.slug,
    privateHostname: row.private_hostname,
    transportMode: row.transport_mode,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function duplicateConstraint(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { code?: string }).code === "23505";
}

const E2EE_AUTH_PREFIX = "ocxe2ee1$";

function decodeFixed(value: string, length: number, label: string): Buffer {
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== length) throw new Error(`${label} must be ${length} bytes`);
  return decoded;
}

function e2eeAuthHash(authSecret: string): string {
  const decoded = decodeFixed(authSecret, 32, "auth secret");
  return `${E2EE_AUTH_PREFIX}${createHash("sha256").update(decoded).digest("base64url")}`;
}

function safeStringEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function validateE2eeEnvelope(envelope: RemoteE2eeEnvelopeRecord): {
  salt: Buffer; nonce: Buffer; ciphertext: Buffer; rootPublicKey: Buffer;
} {
  if (envelope.version !== "ocx-e2ee-v1" || envelope.kdf.algorithm !== "argon2id") {
    throw new Error("unsupported remote vault profile");
  }
  if (
    envelope.kdf.memoryKiB < 32_768 || envelope.kdf.memoryKiB > 262_144
    || envelope.kdf.iterations < 2 || envelope.kdf.iterations > 8
    || envelope.kdf.parallelism < 1 || envelope.kdf.parallelism > 4
    || envelope.kdf.outputLength !== 32
  ) throw new Error("invalid remote vault KDF parameters");
  const ciphertext = Buffer.from(envelope.ciphertext, "base64url");
  if (ciphertext.length < 17 || ciphertext.length > 4096) throw new Error("invalid encrypted remote vault");
  const rootPublicKey = Buffer.from(envelope.rootPublicKey, "base64url");
  if (rootPublicKey.length < 32 || rootPublicKey.length > 128) throw new Error("invalid remote root public key");
  const parsed = createPublicKey({ key: rootPublicKey, format: "der", type: "spki" });
  if (parsed.asymmetricKeyType !== "ed25519") throw new Error("remote root key must be Ed25519");
  return {
    salt: decodeFixed(envelope.salt, 16, "vault salt"),
    nonce: decodeFixed(envelope.nonce, 12, "vault nonce"),
    ciphertext,
    rootPublicKey,
  };
}

function envelopeFromRow(row: {
  auth_version: string;
  vault_salt: Buffer | null;
  vault_nonce: Buffer | null;
  encrypted_vault_key: Buffer | null;
  vault_kdf: RemoteE2eeEnvelopeRecord["kdf"] | null;
  root_public_key: Buffer | null;
} | undefined): RemoteE2eeEnvelopeRecord | null {
  if (
    !row || row.auth_version !== "ocx-e2ee-v1"
    || !row.vault_salt || !row.vault_nonce || !row.encrypted_vault_key
    || !row.vault_kdf || !row.root_public_key
  ) return null;
  return {
    version: "ocx-e2ee-v1",
    salt: row.vault_salt.toString("base64url"),
    nonce: row.vault_nonce.toString("base64url"),
    ciphertext: row.encrypted_vault_key.toString("base64url"),
    rootPublicKey: row.root_public_key.toString("base64url"),
    kdf: row.vault_kdf,
  };
}

const RESERVED_INSTANCE_SLUGS = new Set([
  "account", "admin", "api", "auth", "billing", "login", "official", "status",
  "support", "verify", "www",
]);

function validInstanceSlug(slug: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)
    && !RESERVED_INSTANCE_SLUGS.has(slug)
    && !/^(?:account|login|support|verify)-/.test(slug);
}

function issuePrivateOriginIp(): string {
  const bytes = randomBytes(3);
  return `10.${192 + bytes[0] % 64}.${bytes[1]}.${1 + bytes[2] % 254}`;
}

export class PlatformStore {
  constructor(readonly db: Database, readonly config: PlatformConfig) {}

  async authorizeUser(user: { id: string; name: string; email: string; githubNumericId?: string | null }): Promise<Actor | null> {
    if (!user.githubNumericId) return null;
    if (user.githubNumericId === this.config.PLATFORM_BOOTSTRAP_GITHUB_ID) {
      await this.db.query(
        "UPDATE users SET role='admin', status='active', updated_at=now() WHERE id=$1 AND github_numeric_id=$2",
        [user.id, user.githubNumericId],
      );
    } else if (this.config.PLATFORM_SIGNUP_MODE === "open") {
      await this.db.query(
        "UPDATE users SET status='active',updated_at=now() WHERE id=$1 AND status='pending_invite'",
        [user.id],
      );
    }
    const result = await this.db.query<{
      id: string; name: string; email: string; github_numeric_id: string;
      role: "user" | "admin"; status: Actor["status"];
    }>("SELECT id,name,email,github_numeric_id,role,status FROM users WHERE id=$1", [user.id]);
    const row = result.rows[0];
    return row ? { id: row.id, name: row.name, email: row.email, githubNumericId: row.github_numeric_id, role: row.role, status: row.status } : null;
  }

  async createDeviceAuthorization(input: {
    deviceName: string;
    platform: string;
    publicKeyDer: Buffer;
    ecdhPublicKeyDer?: Buffer;
    networkSignal: string;
  }): Promise<{ id: string; pollSecret: string; userCode: string; authorizeUrl: string; expiresAt: string }> {
    if (input.publicKeyDer.length < 32 || input.publicKeyDer.length > 256) throw new Error("invalid device public key");
    const signingKey = createPublicKey({ key: input.publicKeyDer, type: "spki", format: "der" });
    if (signingKey.asymmetricKeyType !== "ed25519") throw new Error("device signing key must be Ed25519");
    if (input.ecdhPublicKeyDer) {
      if (input.ecdhPublicKeyDer.length < 64 || input.ecdhPublicKeyDer.length > 256) throw new Error("invalid device ECDH key");
      const ecdhKey = createPublicKey({ key: input.ecdhPublicKeyDer, type: "spki", format: "der" });
      if (ecdhKey.asymmetricKeyType !== "ec" || ecdhKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
        throw new Error("device ECDH key must use P-256");
      }
    }
    const pollSecret = issueOpaqueToken("ocxr_device_");
    const userCode = issueShortCode(8);
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    const signal = networkSignalHmac(input.networkSignal, this.config.auditHmacKey);
    const id = await this.db.transaction(async client => {
      await client.query("DELETE FROM device_authorization_requests WHERE expires_at<now()-interval '1 day'");
      const capacity = await client.query<{ network_count: string; global_count: string }>(
        `SELECT
           count(*) FILTER(WHERE network_hmac=$1)::text AS network_count,
           count(*)::text AS global_count
         FROM device_authorization_requests
         WHERE created_at>now()-interval '10 minutes'`,
        [signal],
      );
      const counts = capacity.rows[0];
      if (Number(counts.network_count) >= 5 || Number(counts.global_count) >= 500) {
        throw new Error("too many device authorization requests");
      }
      const result = await client.query<{ id: string }>(
        `INSERT INTO device_authorization_requests(
           poll_secret_hash,user_code,device_name,platform,public_key,ecdh_public_key,network_hmac,expires_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [sha256(pollSecret), userCode, input.deviceName, input.platform, input.publicKeyDer, input.ecdhPublicKeyDer ?? null, signal, expiresAt],
      );
      return result.rows[0].id;
    });
    return {
      id,
      pollSecret,
      userCode,
      authorizeUrl: `${this.config.PLATFORM_BASE_URL.replace(/\/$/, "")}/connect/${id}`,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async getDeviceAuthorizationDisplay(id: string): Promise<DeviceAuthorizationDisplay | null> {
    const result = await this.db.query<{
      id: string; user_code: string; device_name: string; platform: string; expires_at: Date;
      approved_at: Date | null; consumed_at: Date | null;
    }>(
      `SELECT id,user_code,device_name,platform,expires_at,approved_at,consumed_at
       FROM device_authorization_requests WHERE id=$1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return null;
    const status = row.expires_at.getTime() <= Date.now()
      ? "expired"
      : row.consumed_at
        ? "consumed"
        : row.approved_at
          ? "approved"
          : "pending";
    return {
      id: row.id,
      userCode: row.user_code,
      deviceName: row.device_name,
      platform: row.platform,
      expiresAt: row.expires_at.toISOString(),
      status,
    };
  }

  async approveDeviceAuthorization(actor: Actor, id: string): Promise<DeviceAuthorizationDisplay> {
    const display = await this.db.transaction(async client => {
      const pending = await client.query<{
        device_name: string; platform: string; public_key: Buffer; ecdh_public_key: Buffer | null; expires_at: Date;
        approved_by: string | null; consumed_at: Date | null;
      }>(
        `SELECT device_name,platform,public_key,ecdh_public_key,expires_at,approved_by,consumed_at
         FROM device_authorization_requests WHERE id=$1 FOR UPDATE`,
        [id],
      );
      const request = pending.rows[0];
      if (!request || request.expires_at.getTime() <= Date.now() || request.consumed_at) {
        throw new Error("device authorization expired");
      }
      if (request.approved_by && request.approved_by !== actor.id) throw new Error("device authorization already approved");
      if (!request.approved_by) {
        const token = issueOpaqueToken("ocxr_device_");
        const relayToken = issueOpaqueToken("ocxr_agent_");
        const device = await client.query<{ id: string }>(
          `INSERT INTO remote_devices(user_id,name,platform,public_key,ecdh_public_key,token_hash,relay_token_hash,last_seen_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,now())
           ON CONFLICT(user_id,public_key) DO UPDATE SET
             name=excluded.name,platform=excluded.platform,ecdh_public_key=excluded.ecdh_public_key,
             token_hash=excluded.token_hash,relay_token_hash=excluded.relay_token_hash,
             last_seen_at=now(),revoked_at=NULL
           RETURNING id`,
          [actor.id, request.device_name, request.platform, request.public_key, request.ecdh_public_key, sha256(token), sha256(relayToken)],
        );
        await client.query(
          `UPDATE device_authorization_requests SET
             approved_by=$2,approved_at=now(),device_id=$3,encrypted_device_token=$4,encrypted_relay_token=$5
           WHERE id=$1`,
          [
            id,
            actor.id,
            device.rows[0].id,
            encryptSecret(token, this.config.encryptionKey),
            encryptSecret(relayToken, this.config.encryptionKey),
          ],
        );
        await this.audit(client, actor.id, "remote_device.approve", null, "success");
      }
      return id;
    });
    const result = await this.getDeviceAuthorizationDisplay(display);
    if (!result) throw new Error("device authorization missing");
    return result;
  }

  async pollDeviceAuthorization(id: string, pollSecret: string): Promise<{
    status: DeviceAuthorizationDisplay["status"];
    deviceId?: string;
    deviceToken?: string;
    relayToken?: string;
    relayUrl?: string;
    user?: { name: string; email: string; githubNumericId: string };
  } | null> {
    const result = await this.db.query<{
      expires_at: Date; approved_at: Date | null; consumed_at: Date | null;
      device_id: string | null; encrypted_device_token: Buffer | null; encrypted_relay_token: Buffer | null;
      name: string | null; email: string | null; github_numeric_id: string | null;
    }>(
      `SELECT r.expires_at,r.approved_at,r.consumed_at,r.device_id,r.encrypted_device_token,r.encrypted_relay_token,
              u.name,u.email,u.github_numeric_id
       FROM device_authorization_requests r
       LEFT JOIN users u ON u.id=r.approved_by
       WHERE r.id=$1 AND r.poll_secret_hash=$2`,
      [id, sha256(pollSecret)],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (row.expires_at.getTime() <= Date.now()) return { status: "expired" };
    if (row.consumed_at) return { status: "consumed" };
    if (!row.approved_at || !row.device_id || !row.encrypted_device_token || !row.name || !row.email || !row.github_numeric_id) {
      return { status: "pending" };
    }
    return {
      status: "approved",
      deviceId: row.device_id,
      deviceToken: decryptSecret(row.encrypted_device_token, this.config.encryptionKey),
      ...(row.encrypted_relay_token ? {
        relayToken: decryptSecret(row.encrypted_relay_token, this.config.encryptionKey),
        relayUrl: this.config.PLATFORM_RELAY_URL,
      } : {}),
      user: { name: row.name, email: row.email, githubNumericId: row.github_numeric_id },
    };
  }

  async acknowledgeDeviceAuthorization(id: string, pollSecret: string): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE device_authorization_requests SET consumed_at=now(),encrypted_device_token=NULL,encrypted_relay_token=NULL
       WHERE id=$1 AND poll_secret_hash=$2 AND approved_at IS NOT NULL
         AND consumed_at IS NULL AND expires_at>now()`,
      [id, sha256(pollSecret)],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async authorizeDeviceToken(token: string): Promise<RemoteDeviceActor | null> {
    if (!token.startsWith("ocxr_device_")) return null;
    const result = await this.db.query<{
      device_id: string; id: string; name: string; email: string; github_numeric_id: string;
      role: "admin" | "user"; status: "active" | "pending_invite" | "suspended";
    }>(
      `UPDATE remote_devices d SET last_seen_at=now()
       FROM users u
       WHERE d.token_hash=$1 AND d.revoked_at IS NULL AND u.id=d.user_id
       RETURNING d.id AS device_id,u.id,u.name,u.email,u.github_numeric_id,u.role,u.status`,
      [sha256(token)],
    );
    const row = result.rows[0];
    if (!row || row.status === "suspended") return null;
    return {
      deviceId: row.device_id,
      actor: {
        id: row.id,
        name: row.name,
        email: row.email,
        githubNumericId: row.github_numeric_id,
        role: row.role,
        status: row.status,
      },
    };
  }

  async rotateRelayCredentials(actor: Actor, deviceId: string, ecdhPublicKey: Buffer): Promise<{
    relayToken: string;
    relayUrl: string;
  }> {
    const parsed = createPublicKey({ key: ecdhPublicKey, type: "spki", format: "der" });
    if (parsed.asymmetricKeyType !== "ec" || parsed.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
      throw new Error("device ECDH key must use P-256");
    }
    const relayToken = issueOpaqueToken("ocxr_agent_");
    const result = await this.db.query(
      `UPDATE remote_devices SET ecdh_public_key=$3,relay_token_hash=$4,
         relay_connected_at=NULL,relay_disconnected_at=now(),updated_at=now()
       WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL`,
      [deviceId, actor.id, ecdhPublicKey, sha256(relayToken)],
    );
    if (!result.rowCount) throw new Error("remote device is unavailable");
    return { relayToken, relayUrl: this.config.PLATFORM_RELAY_URL };
  }

  async authorizeRelayToken(token: string): Promise<RelayDeviceActor | null> {
    if (!token.startsWith("ocxr_agent_")) return null;
    return this.db.transaction(async client => {
      const result = await client.query<{
        device_id: string; instance_id: string | null; device_name: string;
        signing_public_key: Buffer; ecdh_public_key: Buffer | null;
        id: string; name: string; email: string; github_numeric_id: string;
        role: "admin" | "user"; status: "active";
      }>(
        `UPDATE remote_devices d SET relay_connected_at=now(),relay_disconnected_at=NULL,last_seen_at=now(),updated_at=now()
         FROM users u,instances i
         WHERE d.relay_token_hash=$1 AND d.revoked_at IS NULL AND u.id=d.user_id AND u.status='active'
           AND i.id=d.instance_id AND i.owner_id=d.user_id AND i.transport_mode='outbound-relay'
           AND i.deleted_at IS NULL AND i.status NOT IN ('suspending','suspended','deleting','deleted')
         RETURNING d.id AS device_id,d.instance_id,d.name AS device_name,
           d.public_key AS signing_public_key,d.ecdh_public_key,
           u.id,u.name,u.email,u.github_numeric_id,u.role,u.status`,
        [sha256(token)],
      );
      const row = result.rows[0];
      if (!row || !row.instance_id || !row.ecdh_public_key) return null;
      await client.query(
        `UPDATE instances SET status='online',updated_at=now()
         WHERE id=$1 AND owner_id=$2 AND transport_mode='outbound-relay' AND deleted_at IS NULL`,
        [row.instance_id, row.id],
      );
      await client.query(
        "SELECT pg_notify('instance_state',$1)",
        [JSON.stringify({ instanceId: row.instance_id, status: "online" })],
      );
      return {
        deviceId: row.device_id,
        instanceId: row.instance_id,
        name: row.device_name,
        signingPublicKey: row.signing_public_key,
        ecdhPublicKey: row.ecdh_public_key,
        actor: {
          id: row.id,
          name: row.name,
          email: row.email,
          githubNumericId: row.github_numeric_id,
          role: row.role,
          status: row.status,
        },
      };
    });
  }

  async markRelayDisconnected(deviceId: string): Promise<void> {
    await this.db.transaction(async client => {
      const disconnected = await client.query<{ instance_id: string | null }>(
        `UPDATE remote_devices SET relay_disconnected_at=now(),updated_at=now()
         WHERE id=$1 AND relay_disconnected_at IS NULL RETURNING instance_id`,
        [deviceId],
      );
      const instanceId = disconnected.rows[0]?.instance_id;
      if (!instanceId) return;
      const offline = await client.query(
        `UPDATE instances i SET status='offline',updated_at=now()
         WHERE i.id=$1 AND i.transport_mode='outbound-relay' AND i.deleted_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM remote_devices d
             WHERE d.instance_id=i.id AND d.revoked_at IS NULL
               AND d.relay_connected_at IS NOT NULL
               AND (d.relay_disconnected_at IS NULL OR d.relay_connected_at>d.relay_disconnected_at)
           )`,
        [instanceId],
      );
      if (offline.rowCount) {
        await client.query(
          "SELECT pg_notify('instance_state',$1)",
          [JSON.stringify({ instanceId, status: "offline" })],
        );
      }
    });
  }

  async listRelayDevices(userId: string, instanceId: string): Promise<RemoteDeviceRecord[]> {
    const result = await this.db.query<{
      id: string; name: string; platform: string; public_key: Buffer; ecdh_public_key: Buffer | null;
      relay_connected_at: Date | null; relay_disconnected_at: Date | null; last_seen_at: Date | null; instance_id: string | null;
    }>(
      `SELECT id,name,platform,public_key,ecdh_public_key,relay_connected_at,relay_disconnected_at,last_seen_at,instance_id
       FROM remote_devices
       WHERE user_id=$1 AND instance_id=$2 AND revoked_at IS NULL
       ORDER BY lower(name),created_at`,
      [userId, instanceId],
    );
    return result.rows.map(device => ({
      id: device.id,
      name: device.name,
      platform: device.platform,
      signingPublicKey: device.public_key.toString("base64url"),
      ecdhPublicKey: device.ecdh_public_key?.toString("base64url") ?? null,
      relayOnline: !!device.relay_connected_at
        && (!device.relay_disconnected_at || device.relay_connected_at > device.relay_disconnected_at),
      lastSeenAt: device.last_seen_at?.toISOString() ?? null,
      instanceId: device.instance_id,
    }));
  }

  async createTerminalSession(
    userId: string,
    instanceId: string,
    deviceId: string,
    commandProfile: TerminalSessionRecord["commandProfile"],
  ): Promise<TerminalSessionRecord> {
    return this.db.transaction(async client => {
      await client.query(
        `UPDATE terminal_sessions SET status='expired',closed_at=now(),updated_at=now()
         WHERE expires_at<=now() AND status IN ('pending','connected')`,
      );
      const device = await client.query(
        `SELECT 1 FROM remote_devices
         WHERE id=$1 AND user_id=$2 AND instance_id=$3 AND revoked_at IS NULL AND ecdh_public_key IS NOT NULL
         FOR UPDATE`,
        [deviceId, userId, instanceId],
      );
      if (!device.rowCount) throw new Error("remote computer is unavailable");
      const active = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM terminal_sessions
         WHERE device_id=$1 AND status IN ('pending','connected') AND expires_at>now()`,
        [deviceId],
      );
      if (Number(active.rows[0]?.count ?? "0") >= 4) throw new Error("remote computer session limit reached");
      const browserToken = issueOpaqueToken("ocxr_session_");
      const expiresAt = new Date(Date.now() + 12 * 60 * 60_000);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO terminal_sessions(instance_id,device_id,user_id,browser_token_hash,command_profile,expires_at)
         VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
        [instanceId, deviceId, userId, sha256(browserToken), commandProfile, expiresAt],
      );
      return {
        id: inserted.rows[0].id,
        instanceId,
        deviceId,
        userId,
        commandProfile,
        expiresAt: expiresAt.toISOString(),
      };
    });
  }

  async resolveTerminalSession(
    userId: string,
    instanceId: string,
    terminalSessionId: string,
  ): Promise<TerminalSessionRecord | null> {
    const result = await this.db.query<{
      id: string; instance_id: string; device_id: string; user_id: string;
      command_profile: TerminalSessionRecord["commandProfile"]; expires_at: Date;
    }>(
      `SELECT id,instance_id,device_id,user_id,command_profile,expires_at
       FROM terminal_sessions
       WHERE id=$1 AND user_id=$2 AND instance_id=$3
         AND status IN ('pending','connected') AND expires_at>now()`,
      [terminalSessionId, userId, instanceId],
    );
    const row = result.rows[0];
    return row ? {
      id: row.id,
      instanceId: row.instance_id,
      deviceId: row.device_id,
      userId: row.user_id,
      commandProfile: row.command_profile,
      expiresAt: row.expires_at.toISOString(),
    } : null;
  }

  async markTerminalConnected(sessionId: string): Promise<void> {
    await this.db.query(
      `UPDATE terminal_sessions SET status='connected',connected_at=coalesce(connected_at,now()),updated_at=now()
       WHERE id=$1 AND status IN ('pending','connected') AND expires_at>now()`,
      [sessionId],
    );
  }

  async markTerminalClosed(sessionId: string): Promise<void> {
    await this.db.query(
      `UPDATE terminal_sessions SET status='closed',closed_at=now(),updated_at=now()
       WHERE id=$1 AND status IN ('pending','connected')`,
      [sessionId],
    );
  }

  async remoteProfile(actor: Actor): Promise<RemoteProfile> {
    const [profile, instance, devices] = await Promise.all([
      this.db.query<{
        password_set: boolean; auth_version: string; vault_salt: Buffer | null; vault_nonce: Buffer | null;
        encrypted_vault_key: Buffer | null; vault_kdf: RemoteE2eeEnvelopeRecord["kdf"] | null; root_public_key: Buffer | null;
      }>(
        `SELECT (password_hash IS NOT NULL AND auth_version='ocx-e2ee-v1') AS password_set,auth_version,vault_salt,vault_nonce,
           encrypted_vault_key,vault_kdf,root_public_key
         FROM remote_access_profiles WHERE user_id=$1`,
        [actor.id],
      ),
      this.db.query<InstanceRow>(
        "SELECT * FROM instances WHERE owner_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1",
        [actor.id],
      ),
      this.db.query<{
        id: string; name: string; platform: string; public_key: Buffer; ecdh_public_key: Buffer | null;
        relay_connected_at: Date | null; relay_disconnected_at: Date | null; last_seen_at: Date | null; instance_id: string | null;
      }>(
        `SELECT id,name,platform,public_key,ecdh_public_key,relay_connected_at,relay_disconnected_at,last_seen_at,instance_id
         FROM remote_devices WHERE user_id=$1 AND revoked_at IS NULL ORDER BY created_at`,
        [actor.id],
      ),
    ]);
    const current = instance.rows[0] ? instanceFromRow(instance.rows[0]) : null;
    return {
      passwordSet: profile.rows[0]?.password_set ?? false,
      canActivate: actor.status === "active",
      e2ee: envelopeFromRow(profile.rows[0]),
      devices: devices.rows.map(device => ({
        id: device.id,
        name: device.name,
        platform: device.platform,
        signingPublicKey: device.public_key.toString("base64url"),
        ecdhPublicKey: device.ecdh_public_key?.toString("base64url") ?? null,
        relayOnline: !!device.relay_connected_at
          && (!device.relay_disconnected_at || device.relay_connected_at > device.relay_disconnected_at),
        lastSeenAt: device.last_seen_at?.toISOString() ?? null,
        instanceId: device.instance_id,
      })),
      instance: current ? {
        ...current,
        publicUrl: `https://${current.slug}.${this.config.PLATFORM_INSTANCE_DOMAIN}`,
      } : null,
    };
  }

  async setRemotePassword(actor: Actor, password: string): Promise<void> {
    const passwordHash = await Bun.password.hash(password, {
      algorithm: "argon2id",
      memoryCost: 65_536,
      timeCost: 3,
    });
    await this.db.transaction(async client => {
      await client.query(
        `INSERT INTO remote_access_profiles(user_id,password_hash,password_set_at)
         VALUES($1,$2,now())
         ON CONFLICT(user_id) DO UPDATE SET
           password_hash=excluded.password_hash,password_set_at=now(),failed_attempts=0,
           locked_until=NULL,updated_at=now()`,
        [actor.id, passwordHash],
      );
      await client.query(
        `UPDATE instance_sessions SET revoked_at=now()
         WHERE user_id=$1 AND revoked_at IS NULL`,
        [actor.id],
      );
      await this.audit(client, actor.id, "remote_password.set", null, "success");
    });
  }

  async setRemoteE2eeProfile(actor: Actor, authSecret: string, envelope: RemoteE2eeEnvelopeRecord): Promise<void> {
    const material = validateE2eeEnvelope(envelope);
    const passwordHash = e2eeAuthHash(authSecret);
    await this.db.transaction(async client => {
      await client.query(
        `INSERT INTO remote_access_profiles(
           user_id,password_hash,password_set_at,auth_version,vault_salt,vault_nonce,
           encrypted_vault_key,vault_kdf,root_public_key
         ) VALUES($1,$2,now(),'ocx-e2ee-v1',$3,$4,$5,$6,$7)
         ON CONFLICT(user_id) DO UPDATE SET
           password_hash=excluded.password_hash,password_set_at=now(),auth_version='ocx-e2ee-v1',
           vault_salt=excluded.vault_salt,vault_nonce=excluded.vault_nonce,
           encrypted_vault_key=excluded.encrypted_vault_key,vault_kdf=excluded.vault_kdf,
           root_public_key=excluded.root_public_key,failed_attempts=0,locked_until=NULL,updated_at=now()`,
        [actor.id, passwordHash, material.salt, material.nonce, material.ciphertext, JSON.stringify(envelope.kdf), material.rootPublicKey],
      );
      await client.query(
        "UPDATE instance_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL",
        [actor.id],
      );
      await this.audit(client, actor.id, "remote_e2ee_profile.set", null, "success");
    });
  }

  async changeRemoteE2eeProfile(
    actor: Actor,
    oldAuthSecret: string,
    newAuthSecret: string,
    envelope: RemoteE2eeEnvelopeRecord,
  ): Promise<void> {
    await this.verifyRemotePassword(actor, oldAuthSecret);
    await this.setRemoteE2eeProfile(actor, newAuthSecret, envelope);
  }

  async activateRemoteInstance(
    actor: Actor,
    deviceId: string,
    input: { name: string; slug: string },
  ): Promise<RemoteProfile> {
    if (actor.status !== "active") throw new Error("private beta access is required");
    const password = await this.db.query(
      `SELECT 1 FROM remote_access_profiles
       WHERE user_id=$1 AND password_hash IS NOT NULL AND auth_version='ocx-e2ee-v1'`,
      [actor.id],
    );
    if (!password.rowCount) throw new Error("set an end-to-end encrypted remote password first");

    const existing = await this.db.query<InstanceRow>(
      "SELECT * FROM instances WHERE owner_id=$1 AND deleted_at IS NULL LIMIT 1",
      [actor.id],
    );
    let instance = existing.rows[0] ? instanceFromRow(existing.rows[0]) : await this.createRelayWorkspace(actor, input.slug);
    if (instance.transportMode === "mesh-tunnel") {
      if (instance.slug !== input.slug.trim().toLowerCase()) throw new Error("existing remote domain must be preserved during relay upgrade");
      const upgraded = await this.db.query<InstanceRow>(
        `UPDATE instances SET transport_mode='outbound-relay',status='awaiting_agent',updated_at=now()
         WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL RETURNING *`,
        [instance.id, actor.id],
      );
      instance = instanceFromRow(upgraded.rows[0]);
      await this.db.query(
        "SELECT pg_notify('instance_state',$1)",
        [JSON.stringify({ instanceId: instance.id, status: "awaiting_agent" })],
      );
    }
    const linked = await this.db.query(
      `UPDATE remote_devices SET instance_id=$3,name=$4,updated_at=now()
       WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL`,
      [deviceId, actor.id, instance.id, input.name.trim()],
    );
    if (!linked.rowCount) throw new Error("remote device is unavailable");
    return this.remoteProfile(actor);
  }

  async createRemotePairingCode(actor: Actor, deviceId: string): Promise<{ code: string; expiresAt: string }> {
    const linked = await this.db.query<{ instance_id: string }>(
      `SELECT instance_id FROM remote_devices
       WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND instance_id IS NOT NULL`,
      [deviceId, actor.id],
    );
    const instanceId = linked.rows[0]?.instance_id;
    if (!instanceId) throw new Error("remote instance is not activated");
    return this.createPairingCode(actor, instanceId);
  }

  async revokeDeviceToken(token: string): Promise<boolean> {
    if (!token.startsWith("ocxr_device_")) return false;
    const result = await this.db.query(
      "UPDATE remote_devices SET revoked_at=now(),token_hash=NULL WHERE token_hash=$1 AND revoked_at IS NULL",
      [sha256(token)],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async redeemInvite(actor: Actor, token: string): Promise<boolean> {
    const result = await this.db.transaction(async client => {
      const invite = await client.query<{ id: string; expected_github_numeric_id: string | null }>(
        `SELECT id,expected_github_numeric_id FROM invites
         WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>now() FOR UPDATE`,
        [sha256(token)],
      );
      const row = invite.rows[0];
      if (!row || (row.expected_github_numeric_id && row.expected_github_numeric_id !== actor.githubNumericId)) return false;
      await client.query("UPDATE invites SET consumed_at=now(),consumed_by=$2 WHERE id=$1", [row.id, actor.id]);
      await client.query("UPDATE users SET status='active',updated_at=now() WHERE id=$1", [actor.id]);
      return true;
    });
    return result;
  }

  async createInvite(actor: Actor, expectedGithubNumericId?: string): Promise<{ token: string; expiresAt: string }> {
    if (actor.role !== "admin" || actor.status !== "active") throw new Error("forbidden");
    const count = await this.db.query<{ count: string }>("SELECT count(*)::text AS count FROM users WHERE status='active'");
    if (Number(count.rows[0]?.count ?? "0") >= 50) throw new Error("private beta user limit reached");
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60_000);
    await this.db.query(
      "INSERT INTO invites(token_hash,created_by,expected_github_numeric_id,expires_at) VALUES($1,$2,$3,$4)",
      [sha256(token), actor.id, expectedGithubNumericId ?? null, expiresAt],
    );
    return { token, expiresAt: expiresAt.toISOString() };
  }

  async listInstances(actor: Actor): Promise<InstanceRecord[]> {
    const result = actor.role === "admin"
      ? await this.db.query<InstanceRow>("SELECT * FROM instances WHERE deleted_at IS NULL ORDER BY created_at DESC")
      : await this.db.query<InstanceRow>("SELECT * FROM instances WHERE owner_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC", [actor.id]);
    return result.rows.map(instanceFromRow);
  }

  async getOwnedInstance(actor: Actor, id: string): Promise<InstanceRecord | null> {
    const result = await this.db.query<InstanceRow>(
      `SELECT * FROM instances WHERE id=$1 AND deleted_at IS NULL AND (owner_id=$2 OR $3='admin')`,
      [id, actor.id, actor.role],
    );
    return result.rows[0] ? instanceFromRow(result.rows[0]) : null;
  }

  async createInstance(actor: Actor, input: { name: string; slug: string }): Promise<InstanceRecord> {
    if (actor.status !== "active") throw new Error("invite required");
    const name = input.name.trim();
    const slug = input.slug.trim().toLowerCase();
    if (name.length < 1 || name.length > 80) throw new Error("name must be 1-80 characters");
    if (!validInstanceSlug(slug)) throw new Error("invalid or reserved slug");
    const privateHostname = `${randomBytes(20).toString("hex")}.${this.config.PLATFORM_PRIVATE_HOSTNAME_DOMAIN}`;
    const privateOriginIp = issuePrivateOriginIp();
    try {
      return await this.db.transaction(async client => {
        const tombstone = await client.query("SELECT 1 FROM slug_tombstones WHERE slug=$1 AND expires_at>now()", [slug]);
        if (tombstone.rowCount) throw new Error("slug is temporarily reserved");
        const result = await client.query<InstanceRow>(
          `INSERT INTO instances(owner_id,name,slug,private_hostname,private_origin_ip)
           VALUES($1,$2,$3,$4,$5) RETURNING *`,
          [actor.id, name, slug, privateHostname, privateOriginIp],
        );
        await client.query(
          `INSERT INTO provisioning_jobs(instance_id,kind,idempotency_key)
           VALUES($1,'provision',$2)`,
          [result.rows[0].id, `provision:${result.rows[0].id}:v1`],
        );
        await this.audit(client, actor.id, "instance.create", result.rows[0].id, "accepted");
        return instanceFromRow(result.rows[0]);
      });
    } catch (error) {
      if (duplicateConstraint(error)) throw new Error("slug is unavailable or instance limit reached");
      throw error;
    }
  }

  async createRelayWorkspace(actor: Actor, requestedSlug: string): Promise<InstanceRecord> {
    if (actor.status !== "active") throw new Error("invite required");
    const slug = requestedSlug.trim().toLowerCase();
    if (!validInstanceSlug(slug)) throw new Error("invalid or reserved slug");
    const privateHostname = `relay-${randomBytes(20).toString("hex")}.invalid`;
    const privateOriginIp = issuePrivateOriginIp();
    try {
      return await this.db.transaction(async client => {
        const tombstone = await client.query("SELECT 1 FROM slug_tombstones WHERE slug=$1 AND expires_at>now()", [slug]);
        if (tombstone.rowCount) throw new Error("slug is temporarily reserved");
        const result = await client.query<InstanceRow>(
          `INSERT INTO instances(owner_id,name,slug,private_hostname,private_origin_ip,status,transport_mode)
           VALUES($1,$2,$3,$4,$5,'awaiting_agent','outbound-relay') RETURNING *`,
          [actor.id, `${actor.name} Remote`, slug, privateHostname, privateOriginIp],
        );
        await this.audit(client, actor.id, "relay_workspace.create", result.rows[0].id, "success");
        return instanceFromRow(result.rows[0]);
      });
    } catch (error) {
      if (duplicateConstraint(error)) throw new Error("domain is unavailable or workspace already exists");
      throw error;
    }
  }

  async createPairingCode(actor: Actor, instanceId: string): Promise<{ code: string; expiresAt: string }> {
    const instance = await this.getOwnedInstance(actor, instanceId);
    if (!instance || !["awaiting_agent", "connecting", "offline"].includes(instance.status)) throw new Error("instance is not ready for pairing");
    const code = issueShortCode();
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    await this.db.transaction(async client => {
      await client.query("UPDATE pairing_codes SET consumed_at=now() WHERE instance_id=$1 AND consumed_at IS NULL", [instanceId]);
      await client.query("INSERT INTO pairing_codes(instance_id,code_hash,expires_at) VALUES($1,$2,$3)", [instanceId, sha256(code), expiresAt]);
      await this.audit(client, actor.id, "pairing_code.create", instanceId, "success");
    });
    return { code, expiresAt: expiresAt.toISOString() };
  }

  async consumePairingCode(input: { code: string; publicKeyDer: Buffer; version: string }): Promise<{
    agentId: string; instanceId: string; tunnelToken: string; privateOriginIp: string;
  }> {
    if (input.publicKeyDer.length < 32 || input.publicKeyDer.length > 256) throw new Error("invalid Ed25519 public key");
    return this.db.transaction(async client => {
      const pairing = await client.query<{ id: string; instance_id: string }>(
        `SELECT id,instance_id FROM pairing_codes
         WHERE code_hash=$1 AND consumed_at IS NULL AND expires_at>now() FOR UPDATE`,
        [sha256(input.code.trim().toUpperCase())],
      );
      const row = pairing.rows[0];
      if (!row) throw new Error("invalid or expired pairing code");
      const agent = await client.query<{ id: string }>(
        `INSERT INTO agents(instance_id,public_key,version)
         VALUES($1,$2,$3)
         ON CONFLICT(instance_id) DO UPDATE SET public_key=excluded.public_key,version=excluded.version,
           status='paired',revoked_at=NULL,auth_token_hash=NULL,auth_token_expires_at=NULL
         RETURNING id`,
        [row.instance_id, input.publicKeyDer, input.version],
      );
      const resource = await client.query<{ encrypted_secret: Buffer }>(
        "SELECT encrypted_secret FROM cloudflare_resources WHERE instance_id=$1 AND resource_type='tunnel' AND deleted_at IS NULL",
        [row.instance_id],
      );
      if (!resource.rows[0]?.encrypted_secret) throw new Error("tunnel token is not provisioned");
      const instance = await client.query<{ private_origin_ip: string }>(
        "SELECT host(private_origin_ip) AS private_origin_ip FROM instances WHERE id=$1",
        [row.instance_id],
      );
      if (!instance.rows[0]?.private_origin_ip) throw new Error("private origin IP is not provisioned");
      await client.query("UPDATE pairing_codes SET consumed_at=now() WHERE id=$1", [row.id]);
      await client.query("UPDATE instances SET status='connecting',updated_at=now() WHERE id=$1", [row.instance_id]);
      return {
        agentId: agent.rows[0].id,
        instanceId: row.instance_id,
        tunnelToken: decryptSecret(resource.rows[0].encrypted_secret, this.config.encryptionKey),
        privateOriginIp: instance.rows[0].private_origin_ip,
      };
    });
  }

  async createAgentChallenge(agentId: string, clientNonce: string): Promise<string> {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(clientNonce)) throw new Error("invalid client nonce");
    const challenge = `${agentId}.${clientNonce}.${randomBytes(32).toString("base64url")}`;
    const result = await this.db.query(
      `UPDATE agents SET challenge_hash=$2,challenge_expires_at=now()+interval '60 seconds'
       WHERE id=$1 AND revoked_at IS NULL RETURNING id`,
      [agentId, sha256(challenge)],
    );
    if (!result.rowCount) throw new Error("agent not found");
    return challenge;
  }

  async exchangeAgentChallenge(agentId: string, challenge: string, signature: Buffer): Promise<{ token: string; expiresAt: string }> {
    return this.db.transaction(async client => {
      const result = await client.query<{ public_key: Buffer; challenge_hash: Buffer }>(
        `SELECT public_key,challenge_hash FROM agents
         WHERE id=$1 AND revoked_at IS NULL AND challenge_expires_at>now() FOR UPDATE`,
        [agentId],
      );
      const agent = result.rows[0];
      if (!agent || !agent.challenge_hash.equals(sha256(challenge))) throw new Error("challenge expired");
      const publicKey = createPublicKey({ key: agent.public_key, format: "der", type: "spki" });
      if (!verify(null, Buffer.from(challenge), publicKey, signature)) throw new Error("invalid challenge signature");
      const token = issueOpaqueToken("ocxr_agent_");
      const expiresAt = new Date(Date.now() + 5 * 60_000);
      await client.query(
        `UPDATE agents SET auth_token_hash=$2,auth_token_expires_at=$3,challenge_hash=NULL,challenge_expires_at=NULL
         WHERE id=$1`,
        [agentId, sha256(token), expiresAt],
      );
      return { token, expiresAt: expiresAt.toISOString() };
    });
  }

  async heartbeat(token: string, input: { opencodexHealthy: boolean; version: string }): Promise<{ instanceId: string }> {
    const result = await this.db.query<{ instance_id: string }>(
      `UPDATE agents SET last_heartbeat_at=now(),version=$2
       WHERE auth_token_hash=$1 AND auth_token_expires_at>now() AND revoked_at IS NULL
       RETURNING instance_id`,
      [sha256(token), input.version],
    );
    const row = result.rows[0];
    if (!row) throw new Error("agent token expired");
    await this.recordHealth(row.instance_id, "agent", input.opencodexHealthy);
    return { instanceId: row.instance_id };
  }

  async issueDataToken(actor: Actor, instanceId: string, name: string): Promise<{ token: string; expiresAt: string }> {
    const instance = await this.getOwnedInstance(actor, instanceId);
    if (!instance || ["suspended", "deleting", "deleted"].includes(instance.status)) throw new Error("instance not found");
    const token = issueOpaqueToken("ocxr_");
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60_000);
    await this.db.query(
      `INSERT INTO access_tokens(instance_id,user_id,name,token_hash,token_hint,expires_at)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [instanceId, actor.id, name.trim().slice(0, 80) || "CLI token", sha256(token), token.slice(-6), expiresAt],
    );
    return { token, expiresAt: expiresAt.toISOString() };
  }

  private async verifyRemotePassword(actor: Actor, password: string): Promise<void> {
    const result = await this.db.transaction(async client => {
      const profile = await client.query<{
        password_hash: string | null; failed_attempts: number; locked_until: Date | null;
      }>(
        `SELECT password_hash,failed_attempts,locked_until FROM remote_access_profiles
         WHERE user_id=$1 FOR UPDATE`,
        [actor.id],
      );
      const row = profile.rows[0];
      if (!row?.password_hash) return "invalid" as const;
      if (row.locked_until && row.locked_until.getTime() > Date.now()) return "locked" as const;
      let valid = false;
      if (row.password_hash.startsWith(E2EE_AUTH_PREFIX)) {
        try { valid = safeStringEqual(row.password_hash, e2eeAuthHash(password)); } catch { valid = false; }
      } else {
        valid = await Bun.password.verify(password, row.password_hash);
      }
      if (!valid) {
        const attempts = row.failed_attempts + 1;
        await client.query(
          `UPDATE remote_access_profiles SET failed_attempts=$2,
             locked_until=CASE WHEN $2>=5 THEN now()+interval '15 minutes' ELSE NULL END,
             updated_at=now() WHERE user_id=$1`,
          [actor.id, attempts],
        );
        await this.audit(client, actor.id, "remote_password.verify", null, "failure");
        return "invalid" as const;
      }
      await client.query(
        "UPDATE remote_access_profiles SET failed_attempts=0,locked_until=NULL,updated_at=now() WHERE user_id=$1",
        [actor.id],
      );
      await this.audit(client, actor.id, "remote_password.verify", null, "success");
      return "valid" as const;
    });
    if (result === "locked") throw new Error("remote password is temporarily locked");
    if (result !== "valid") throw new Error("invalid remote password");
  }

  async issueInstanceAuthorization(actor: Actor, instanceId: string, password: string): Promise<string> {
    const result = await this.db.query<InstanceRow>(
      "SELECT * FROM instances WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL",
      [instanceId, actor.id],
    );
    const instance = result.rows[0] ? instanceFromRow(result.rows[0]) : null;
    const available = instance && (
      ["online", "degraded"].includes(instance.status)
      || (instance.transportMode === "outbound-relay" && ["awaiting_agent", "offline"].includes(instance.status))
    );
    if (!available) throw new Error("instance is unavailable");
    await this.verifyRemotePassword(actor, password);
    const code = randomBytes(32).toString("base64url");
    await this.db.query(
      `INSERT INTO instance_authorization_codes(instance_id,user_id,code_hash,expires_at)
       VALUES($1,$2,$3,now()+interval '60 seconds')`,
      [instanceId, actor.id, sha256(code)],
    );
    return `https://${instance.slug}.${this.config.PLATFORM_INSTANCE_DOMAIN}/_ocxr/exchange?code=${encodeURIComponent(code)}`;
  }

  async issueInstanceAuthorizationForSlug(actor: Actor, slug: string, password: string): Promise<string> {
    const result = await this.db.query<{ id: string }>(
      "SELECT id FROM instances WHERE owner_id=$1 AND slug=$2 AND deleted_at IS NULL",
      [actor.id, slug.toLowerCase()],
    );
    const instanceId = result.rows[0]?.id;
    if (!instanceId) throw new Error("instance is unavailable");
    return this.issueInstanceAuthorization(actor, instanceId, password);
  }

  async exchangeInstanceAuthorization(host: string, code: string): Promise<{ token: string; expiresAt: Date } | null> {
    return this.db.transaction(async client => {
      const authorization = await client.query<{ id: string; instance_id: string; user_id: string }>(
        `SELECT c.id,c.instance_id,c.user_id FROM instance_authorization_codes c
         JOIN instances i ON i.id=c.instance_id
         JOIN users u ON u.id=c.user_id
         WHERE c.code_hash=$1 AND c.consumed_at IS NULL AND c.expires_at>now()
           AND i.slug=$2 AND (
             i.status IN ('online','degraded')
             OR (i.transport_mode='outbound-relay' AND i.status IN ('awaiting_agent','offline'))
           ) AND u.status='active'
         FOR UPDATE OF c`,
        [sha256(code), this.slugFromHost(host)],
      );
      const row = authorization.rows[0];
      if (!row) return null;
      const token = issueOpaqueToken("ocxr_session_");
      const expiresAt = new Date(Date.now() + 12 * 60 * 60_000);
      await client.query("UPDATE instance_authorization_codes SET consumed_at=now() WHERE id=$1", [row.id]);
      await client.query(
        "INSERT INTO instance_sessions(instance_id,user_id,token_hash,expires_at) VALUES($1,$2,$3,$4)",
        [row.instance_id, row.user_id, sha256(token), expiresAt],
      );
      return { token, expiresAt };
    });
  }

  async resolveGatewayRequest(host: string, authorization: string | null, sessionToken: string | null, path: string): Promise<{
    instance: InstanceRecord; userId: string;
  } | null> {
    const slug = this.slugFromHost(host);
    if (!slug) return null;
    const instanceResult = await this.db.query<InstanceRow>(
      `SELECT i.* FROM instances i JOIN users u ON u.id=i.owner_id
       WHERE i.slug=$1 AND (
         i.status IN ('online','degraded')
         OR (i.transport_mode='outbound-relay' AND i.status IN ('awaiting_agent','offline'))
       ) AND i.deleted_at IS NULL AND u.status='active'`,
      [slug],
    );
    const row = instanceResult.rows[0];
    if (!row) return null;
    if (path.startsWith("/v1/")) {
      const token = authorization?.replace(/^Bearer\s+/i, "").trim();
      if (token?.startsWith("ocxr_") && !token.startsWith("ocxr_session_") && !token.startsWith("ocxr_agent_")) {
        const access = await this.db.query<{ user_id: string }>(
          `UPDATE access_tokens SET last_used_at=now()
           WHERE instance_id=$1 AND token_hash=$2 AND expires_at>now() AND revoked_at IS NULL
           RETURNING user_id`,
          [row.id, sha256(token)],
        );
        return access.rows[0] ? { instance: instanceFromRow(row), userId: access.rows[0].user_id } : null;
      }
      // Browser-driven `/v1/*` calls are bound to the same instance session as
      // the GUI. A separate remote token can ride in x-opencodex-remote-token
      // when Authorization must be preserved for ChatGPT Direct.
      if (!sessionToken) return null;
    }
    if (!sessionToken) return null;
    const session = await this.db.query<{ user_id: string }>(
      `SELECT user_id FROM instance_sessions
       WHERE instance_id=$1 AND token_hash=$2 AND expires_at>now() AND revoked_at IS NULL`,
      [row.id, sha256(sessionToken)],
    );
    return session.rows[0] ? { instance: instanceFromRow(row), userId: session.rows[0].user_id } : null;
  }

  async suspendInstance(actor: Actor, instanceId: string): Promise<void> {
    const instance = await this.getOwnedInstance(actor, instanceId);
    if (!instance) throw new Error("instance not found");
    await this.db.transaction(async client => {
      await client.query("UPDATE instances SET status='suspending',suspended_at=now(),updated_at=now() WHERE id=$1", [instanceId]);
      await client.query("UPDATE agents SET revoked_at=now(),auth_token_hash=NULL WHERE instance_id=$1", [instanceId]);
      await client.query("UPDATE access_tokens SET revoked_at=now() WHERE instance_id=$1 AND revoked_at IS NULL", [instanceId]);
      await client.query("UPDATE instance_sessions SET revoked_at=now() WHERE instance_id=$1 AND revoked_at IS NULL", [instanceId]);
      await client.query(
        `INSERT INTO provisioning_jobs(instance_id,kind,idempotency_key)
         VALUES($1,'suspend',$2) ON CONFLICT(idempotency_key) DO NOTHING`,
        [instanceId, `suspend:${instanceId}:${Date.now()}`],
      );
      await client.query("SELECT pg_notify('instance_state',$1)", [JSON.stringify({ instanceId, status: "suspending" })]);
      await this.audit(client, actor.id, "instance.suspend", instanceId, "accepted");
    });
  }

  async deleteInstance(actor: Actor, instanceId: string): Promise<void> {
    const instance = await this.getOwnedInstance(actor, instanceId);
    if (!instance) throw new Error("instance not found");
    await this.db.transaction(async client => {
      await client.query("UPDATE instances SET status='deleting',updated_at=now() WHERE id=$1", [instanceId]);
      await client.query("UPDATE agents SET revoked_at=now(),auth_token_hash=NULL WHERE instance_id=$1", [instanceId]);
      await client.query("UPDATE access_tokens SET revoked_at=now() WHERE instance_id=$1 AND revoked_at IS NULL", [instanceId]);
      await client.query("UPDATE instance_sessions SET revoked_at=now() WHERE instance_id=$1 AND revoked_at IS NULL", [instanceId]);
      await client.query(
        `INSERT INTO provisioning_jobs(instance_id,kind,idempotency_key)
         VALUES($1,'delete',$2) ON CONFLICT(idempotency_key) DO NOTHING`,
        [instanceId, `delete:${instanceId}:v1`],
      );
      await client.query("SELECT pg_notify('instance_state',$1)", [JSON.stringify({ instanceId, status: "deleting" })]);
      await this.audit(client, actor.id, "instance.delete", instanceId, "accepted");
    });
  }

  async recordHealth(instanceId: string, signal: "agent" | "tunnel" | "gateway", healthy: boolean): Promise<void> {
    await this.db.query(
      "INSERT INTO health_observations(instance_id,signal,healthy) VALUES($1,$2,$3)",
      [instanceId, signal, healthy],
    );
  }

  async refreshComputedHealth(instanceId: string): Promise<InstanceStatus> {
    const result = await this.db.query<{ signal: string; healthy: boolean; observed_at: Date }>(
      `SELECT DISTINCT ON(signal) signal,healthy,observed_at FROM health_observations
       WHERE instance_id=$1 ORDER BY signal,observed_at DESC`,
      [instanceId],
    );
    const fresh = new Map(result.rows.filter(row => Date.now() - row.observed_at.getTime() <= 90_000).map(row => [row.signal, row.healthy]));
    const values = ["agent", "tunnel", "gateway"].map(signal => fresh.get(signal));
    const status: InstanceStatus = values.every(value => value === true) ? "online"
      : values.every(value => value === undefined) ? "offline" : "degraded";
    await this.db.query(
      `UPDATE instances SET status=$2,updated_at=now()
       WHERE id=$1 AND status NOT IN ('suspending','suspended','deleting','delete_failed','deleted')`,
      [instanceId, status],
    );
    return status;
  }

  async saveCloudflareResource(
    instanceId: string,
    resourceType: "tunnel" | "private_dns" | "cidr_activation_route" | "hostname_route",
    externalId: string,
    secret?: string,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO cloudflare_resources(instance_id,resource_type,external_id,encrypted_secret)
       VALUES($1,$2,$3,$4)
       ON CONFLICT(instance_id,resource_type) DO UPDATE SET external_id=excluded.external_id,
         encrypted_secret=excluded.encrypted_secret,disabled_at=NULL,deleted_at=NULL`,
      [instanceId, resourceType, externalId, secret ? encryptSecret(secret, this.config.encryptionKey) : null],
    );
  }

  private slugFromHost(host: string): string | null {
    const hostname = host.toLowerCase().replace(/:\d+$/, "");
    const suffix = `.${this.config.PLATFORM_INSTANCE_DOMAIN.toLowerCase()}`;
    if (!hostname.endsWith(suffix)) return null;
    const slug = hostname.slice(0, -suffix.length);
    return /^[a-z0-9-]{1,63}$/.test(slug) ? slug : null;
  }

  private audit(client: PoolClient, actorId: string | null, action: string, instanceId: string | null, result: string): Promise<unknown> {
    const requestId = randomUUID();
    return client.query(
      `INSERT INTO audit_logs(actor_id,action,instance_id,result,request_id,network_hmac)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [actorId, action, instanceId, result, requestId, networkSignalHmac(requestId, this.config.auditHmacKey)],
    );
  }
}
