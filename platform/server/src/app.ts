import { Hono, type Context } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { serveStatic } from "hono/bun";
import { z } from "zod";
import type { PlatformConfig } from "./config";
import type { PlatformAuth } from "./auth";
import type { Actor, PlatformStore } from "./store";
import { gatewayPublicKeyPem } from "./security";

interface AppVariables {
  actor: Actor | null;
  remoteDeviceId: string | null;
}

const e2eeEnvelopeSchema = z.object({
  version: z.literal("ocx-e2ee-v1"),
  salt: z.string().min(20).max(32),
  nonce: z.string().min(16).max(24),
  ciphertext: z.string().min(24).max(6_000),
  rootPublicKey: z.string().min(40).max(256),
  kdf: z.object({
    algorithm: z.literal("argon2id"),
    memoryKiB: z.number().int().min(32_768).max(262_144),
    iterations: z.number().int().min(2).max(8),
    parallelism: z.number().int().min(1).max(4),
    outputLength: z.literal(32),
  }),
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "request failed";
}

function bearer(req: Request): string {
  return req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? "";
}

async function requireActor(c: Context<{ Variables: AppVariables }>): Promise<Actor | Response> {
  const actor = c.get("actor");
  if (!actor) return c.json({ error: "not found" }, 404);
  if (actor.status === "suspended") return c.json({ error: "not found" }, 404);
  return actor;
}

function requireRemoteDevice(c: Context<{ Variables: AppVariables }>): string | Response {
  const deviceId = c.get("remoteDeviceId");
  return deviceId ?? c.json({ error: "remote device authentication required" }, 401);
}

export function createControlPlaneApp(config: PlatformConfig, auth: PlatformAuth, store: PlatformStore) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", secureHeaders({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https://avatars.githubusercontent.com"],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
    },
  }));
  app.use("/api/v1/*", async (c, next) => {
    let actor: Actor | null = null;
    const device = await store.authorizeDeviceToken(bearer(c.req.raw));
    if (device) {
      actor = device.actor;
      c.set("remoteDeviceId", device.deviceId);
    } else if (config.NODE_ENV !== "production" && config.PLATFORM_DEV_AUTH_GITHUB_ID) {
      const result = await store.db.query<{ id: string; name: string; email: string; github_numeric_id: string }>(
        "SELECT id,name,email,github_numeric_id FROM users WHERE github_numeric_id=$1",
        [config.PLATFORM_DEV_AUTH_GITHUB_ID],
      );
      const user = result.rows[0];
      if (user) actor = await store.authorizeUser({ id: user.id, name: user.name, email: user.email, githubNumericId: user.github_numeric_id });
    } else {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      if (session?.user) {
        const user = session.user as typeof session.user & { githubNumericId?: string | null };
        actor = await store.authorizeUser({
          id: user.id,
          name: user.name,
          email: user.email,
          githubNumericId: user.githubNumericId,
        });
      }
    }
    if (!device) c.set("remoteDeviceId", null);
    c.set("actor", actor);
    await next();
  });

  app.on(["GET", "POST"], "/api/auth/*", c => auth.handler(c.req.raw));
  app.get("/healthz", c => c.json({ ok: true, service: "control-plane" }));

  app.post("/api/v1/device-links", async c => {
    try {
      const body = z.object({
        deviceName: z.string().trim().min(1).max(80),
        platform: z.string().trim().min(1).max(40),
        publicKey: z.string().min(40).max(512),
        ecdhPublicKey: z.string().min(80).max(512).optional(),
      }).parse(await c.req.json());
      const networkSignal = c.req.header("cf-connecting-ip")
        ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
        ?? "unknown";
      const deviceLink = await store.createDeviceAuthorization({
        deviceName: body.deviceName,
        platform: body.platform,
        publicKeyDer: Buffer.from(body.publicKey, "base64url"),
        ecdhPublicKeyDer: body.ecdhPublicKey ? Buffer.from(body.ecdhPublicKey, "base64url") : undefined,
        networkSignal,
      });
      const requestOrigin = new URL(c.req.url);
      const loopbackRequest = requestOrigin.protocol === "http:"
        && ["127.0.0.1", "localhost"].includes(requestOrigin.hostname);
      if (
        config.NODE_ENV !== "production"
        && config.PLATFORM_DEV_AUTO_APPROVE_DEVICE_LINKS === "true"
        && loopbackRequest
      ) {
        // The client rejects cross-origin authorization URLs. Keep a local test
        // entirely on loopback while the public response continues to use the
        // configured HTTPS origin.
        deviceLink.authorizeUrl = `${requestOrigin.origin}/connect/${deviceLink.id}`;
      }
      // [Decision Log]
      // - 목적과 의도: 실제 GitHub OAuth 준비 전에도 로컬 OCX Remote 연결 전체 흐름을 한 번의 클릭으로 검증한다.
      // - 기존 구현 및 제약 조건: 개발 계정 우회는 API actor만 제공해서 장치 승인 버튼을 별도로 눌러야 했고, 공개 배포에서는 절대 자동 승인되면 안 된다.
      // - 검토한 주요 대안: 프런트엔드에서 승인 API 호출, 모든 개발 환경에서 무조건 자동 승인, 명시적인 서버 플래그.
      // - 선택한 방식: non-production, 개발 actor, 명시적 auto-approve 플래그가 모두 존재할 때만 생성 직후 승인한다.
      // - 다른 대안 대신 이 방식을 선택한 이유: 비밀이나 우회 토큰을 브라우저에 추가하지 않고 production의 GitHub 소유권 경계를 그대로 보존한다.
      // - 장점, 단점 및 영향: 테스트는 한 번의 클릭으로 진행되지만 이 플래그를 켠 개발 배포는 접근 가능한 사람이 bootstrap 계정으로 장치를 등록할 수 있으므로 공개 운영에는 사용할 수 없다.
      const actor = c.get("actor");
      if (
        config.NODE_ENV !== "production"
        && config.PLATFORM_DEV_AUTH_GITHUB_ID
        && config.PLATFORM_DEV_AUTO_APPROVE_DEVICE_LINKS === "true"
        && actor
      ) {
        await store.approveDeviceAuthorization(actor, deviceLink.id);
      }
      return c.json(deviceLink, 201);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.get("/api/v1/device-links/:id", async c => {
    const pollSecret = c.req.header("x-ocxr-link-secret");
    if (pollSecret) {
      const result = await store.pollDeviceAuthorization(c.req.param("id"), pollSecret);
      return result ? c.json(result) : c.json({ error: "not found" }, 404);
    }
    const display = await store.getDeviceAuthorizationDisplay(c.req.param("id"));
    return display ? c.json({ request: display }) : c.json({ error: "not found" }, 404);
  });

  app.post("/api/v1/device-links/:id/approve", async c => {
    const actor = await requireActor(c);
    if (actor instanceof Response) return actor;
    try {
      return c.json({ request: await store.approveDeviceAuthorization(actor, c.req.param("id")) });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 409);
    }
  });

  app.post("/api/v1/device-links/:id/ack", async c => {
    const pollSecret = c.req.header("x-ocxr-link-secret") ?? "";
    return await store.acknowledgeDeviceAuthorization(c.req.param("id"), pollSecret)
      ? c.json({ ok: true })
      : c.json({ error: "not found" }, 404);
  });

  app.get("/api/v1/me", async c => {
    const actor = await requireActor(c);
    return actor instanceof Response ? actor : c.json({ user: actor });
  });

  app.get("/api/v1/remote/profile", async c => {
    const actor = await requireActor(c);
    return actor instanceof Response ? actor : c.json({ profile: await store.remoteProfile(actor) });
  });

  app.put("/api/v1/remote/password", async c => {
    const actor = await requireActor(c);
    if (actor instanceof Response) return actor;
    const body = z.object({ password: z.string().min(10).max(128) }).parse(await c.req.json());
    await store.setRemotePassword(actor, body.password);
    return c.json({ ok: true });
  });

  app.put("/api/v1/remote/e2ee-profile", async c => {
    const actor = await requireActor(c);
    if (actor instanceof Response) return actor;
    try {
      const body = z.object({
        authSecret: z.string().min(43).max(44),
        envelope: e2eeEnvelopeSchema,
      }).parse(await c.req.json());
      await store.setRemoteE2eeProfile(actor, body.authSecret, body.envelope);
      return c.json({ profile: await store.remoteProfile(actor) });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.post("/api/v1/remote/e2ee-profile/change", async c => {
    const actor = await requireActor(c);
    if (actor instanceof Response) return actor;
    try {
      const body = z.object({
        oldAuthSecret: z.string().min(43).max(44),
        newAuthSecret: z.string().min(43).max(44),
        envelope: e2eeEnvelopeSchema,
      }).parse(await c.req.json());
      await store.changeRemoteE2eeProfile(actor, body.oldAuthSecret, body.newAuthSecret, body.envelope);
      return c.json({ profile: await store.remoteProfile(actor) });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 401);
    }
  });

  app.post("/api/v1/devices/current/relay-credentials", async c => {
    const actor = await requireActor(c);
    if (actor instanceof Response) return actor;
    const deviceId = requireRemoteDevice(c);
    if (deviceId instanceof Response) return deviceId;
    try {
      const body = z.object({ ecdhPublicKey: z.string().min(80).max(512) }).parse(await c.req.json());
      return c.json(await store.rotateRelayCredentials(actor, deviceId, Buffer.from(body.ecdhPublicKey, "base64url")), 201);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.post("/api/v1/remote/activate", async c => {
    const actor = await requireActor(c);
    if (actor instanceof Response) return actor;
    const deviceId = requireRemoteDevice(c);
    if (deviceId instanceof Response) return deviceId;
    try {
      const body = z.object({
        name: z.string().trim().min(1).max(80),
        slug: z.string().trim().min(1).max(63),
      }).parse(await c.req.json());
      return c.json({ profile: await store.activateRemoteInstance(actor, deviceId, body) }, 202);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.post("/api/v1/remote/pairing-code", async c => {
    const actor = await requireActor(c);
    if (actor instanceof Response) return actor;
    const deviceId = requireRemoteDevice(c);
    if (deviceId instanceof Response) return deviceId;
    try {
      return c.json(await store.createRemotePairingCode(actor, deviceId), 201);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 409);
    }
  });

  app.post("/api/v1/remote/access/:slug", async c => {
    const actor = await requireActor(c);
    if (actor instanceof Response) return actor;
    try {
      const body = z.object({
        authSecret: z.string().min(43).max(44).optional(),
        password: z.string().min(10).max(128).optional(),
      }).refine(value => !!value.authSecret || !!value.password).parse(await c.req.json());
      return c.json({
        url: await store.issueInstanceAuthorizationForSlug(actor, c.req.param("slug"), body.authSecret ?? body.password ?? ""),
      }, 201);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 401);
    }
  });

  app.delete("/api/v1/devices/current", async c => {
    const token = bearer(c.req.raw);
    return await store.revokeDeviceToken(token)
      ? c.json({ ok: true })
      : c.json({ error: "not found" }, 404);
  });

  app.post("/api/v1/invites/redeem", async c => {
    const actor = await requireActor(c);
    if (actor instanceof Response) return actor;
    const body = z.object({ token: z.string().min(32).max(128) }).parse(await c.req.json());
    return await store.redeemInvite(actor, body.token)
      ? c.json({ ok: true })
      : c.json({ error: "invalid or expired invite" }, 400);
  });

  app.post("/api/v1/admin/invites", async c => {
    const actor = await requireActor(c);
    if (actor instanceof Response) return actor;
    try {
      const body = z.object({ githubNumericId: z.string().regex(/^\d+$/).optional() }).parse(await c.req.json());
      return c.json(await store.createInvite(actor, body.githubNumericId), 201);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.get("/api/v1/instances", async c => {
    const actor = await requireActor(c);
    return actor instanceof Response ? actor : c.json({ instances: await store.listInstances(actor) });
  });

  app.post("/api/v1/instances", async c => {
    const actor = await requireActor(c);
    if (actor instanceof Response) return actor;
    try {
      const body = z.object({ name: z.string(), slug: z.string() }).parse(await c.req.json());
      return c.json({ instance: await store.createInstance(actor, body) }, 202);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.get("/api/v1/instances/:id", async c => {
    const actor = await requireActor(c);
    if (actor instanceof Response) return actor;
    const instance = await store.getOwnedInstance(actor, c.req.param("id"));
    return instance ? c.json({ instance }) : c.json({ error: "not found" }, 404);
  });

  app.post("/api/v1/instances/:id/pairing-code", async c => {
    const actor = await requireActor(c);
    if (actor instanceof Response) return actor;
    try {
      return c.json(await store.createPairingCode(actor, c.req.param("id")), 201);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.post("/api/v1/instances/:id/tokens", async c => {
    const actor = await requireActor(c);
    if (actor instanceof Response) return actor;
    try {
      const body = z.object({ name: z.string().max(80).default("CLI token") }).parse(await c.req.json());
      return c.json(await store.issueDataToken(actor, c.req.param("id"), body.name), 201);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.post("/api/v1/instances/:id/authorize", async c => {
    const actor = await requireActor(c);
    if (actor instanceof Response) return actor;
    try {
      const body = z.object({ password: z.string().min(10).max(128) }).parse(await c.req.json());
      return c.json({ url: await store.issueInstanceAuthorization(actor, c.req.param("id"), body.password) }, 201);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 409);
    }
  });

  app.post("/api/v1/instances/:id/suspend", async c => {
    const actor = await requireActor(c);
    if (actor instanceof Response) return actor;
    try {
      await store.suspendInstance(actor, c.req.param("id"));
      return c.json({ ok: true }, 202);
    } catch {
      return c.json({ error: "not found" }, 404);
    }
  });

  app.delete("/api/v1/instances/:id", async c => {
    const actor = await requireActor(c);
    if (actor instanceof Response) return actor;
    try {
      await store.deleteInstance(actor, c.req.param("id"));
      return c.json({ ok: true }, 202);
    } catch {
      return c.json({ error: "not found" }, 404);
    }
  });

  app.post("/agent/pair", async c => {
    try {
      const body = z.object({
        code: z.string().length(12),
        publicKey: z.string().min(40).max(512),
        version: z.string().min(1).max(64),
      }).parse(await c.req.json());
      const paired = await store.consumePairingCode({
        code: body.code,
        publicKeyDer: Buffer.from(body.publicKey, "base64url"),
        version: body.version,
      });
      return c.json({
        ...paired,
        gateway: {
          issuer: config.PLATFORM_GATEWAY_ISSUER,
          keys: [{ kid: config.PLATFORM_GATEWAY_KID, publicKeyPem: gatewayPublicKeyPem(config) }],
        },
      }, 201);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  });

  app.post("/agent/challenge", async c => {
    try {
      const body = z.object({ agentId: z.string().uuid(), clientNonce: z.string() }).parse(await c.req.json());
      return c.json({ challenge: await store.createAgentChallenge(body.agentId, body.clientNonce) });
    } catch {
      return c.json({ error: "agent not found" }, 404);
    }
  });

  app.post("/agent/token", async c => {
    try {
      const body = z.object({ agentId: z.string().uuid(), challenge: z.string(), signature: z.string() }).parse(await c.req.json());
      return c.json(await store.exchangeAgentChallenge(
        body.agentId,
        body.challenge,
        Buffer.from(body.signature, "base64url"),
      ));
    } catch {
      return c.json({ error: "challenge rejected" }, 401);
    }
  });

  app.post("/agent/heartbeat", async c => {
    try {
      const body = z.object({ opencodexHealthy: z.boolean(), version: z.string().max(64) }).parse(await c.req.json());
      return c.json(await store.heartbeat(bearer(c.req.raw), body));
    } catch {
      return c.json({ error: "agent authentication required" }, 401);
    }
  });

  // Keep missing machine endpoints JSON-shaped. The SPA fallback below is for
  // browser routes only and must never turn an API typo into a successful HTML response.
  app.all("/api/*", c => c.json({ error: "not found" }, 404));
  app.all("/agent/*", c => c.json({ error: "not found" }, 404));
  app.get("*", serveStatic({ root: "./web/dist" }));
  app.get("*", serveStatic({ path: "./web/dist/index.html" }));
  app.notFound(c => c.json({ error: "not found" }, 404));
  app.onError((error, c) => {
    if (error instanceof z.ZodError) return c.json({ error: "invalid request", issues: error.issues }, 400);
    return c.json({ error: "internal error" }, 500);
  });
  return app;
}
