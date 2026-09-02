import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKiroAdapter } from "../src/adapters/kiro";
import { KIRO_BUILDER_ID_SERVICE_PROFILE_ARN } from "../src/adapters/kiro-constants";
import { getValidAccessTokenSnapshot } from "../src/oauth";
import { resolveKiroApiRegion, resolveKiroProfileArn, resolveKiroRequestProfileArn } from "../src/oauth/kiro";
import { removeTreeWithRetry } from "./helpers/remove-tree";

/** Mirrors resolveKiroCliNativeSessionEntries so an accountless request reads a real local import. */
function seedKiroCliBuilderIdSession(): void {
  const dir = process.platform === "win32"
    ? join(tmp, "AppData", "Local", "Kiro-Cli")
    : process.platform === "darwin"
      ? join(tmp, "Library", "Application Support", "kiro-cli")
      : join(tmp, ".local", "share", "kiro-cli");
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "data.sqlite3"));
  db.run("CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)");
  db.run("INSERT INTO auth_kv (key, value) VALUES (?, ?)", [
    "kirocli:social:token",
    // Builder ID shape: a device-registration client pair and NO profile_arn.
    JSON.stringify({
      access_token: "local-access",
      refresh_token: "local-refresh",
      region: "us-east-1",
      client_id: "local-client-id",
      client_secret: "local-client-secret",
    }),
  ]);
  db.close();
}
import { saveCredential } from "../src/oauth/store";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";

/**
 * Issue #993 follow-up: an AWS Builder ID account authenticates through SSO OIDC and never receives
 * an account-scoped CodeWhisperer profile ARN, so every gated-model request failed with
 * `kiro_profile_required` and the suggested remediation (re-login to capture the profile) could
 * never succeed. The adapter now sends Kiro's fixed service profile for those accounts, exactly as
 * the Kiro CLI does, while the account's stored identity stays empty.
 */

const origHome = process.env.HOME;
const origLocalAppData = process.env.LOCALAPPDATA;
const origUserProfile = process.env.USERPROFILE;
const origRegion = process.env.KIRO_REGION;
const origApiRegion = process.env.KIRO_API_REGION;
const origArn = process.env.KIRO_PROFILE_ARN;
const origOcxHome = process.env.OPENCODEX_HOME;
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "kiro-builder-id-"));
  process.env.HOME = tmp;
  process.env.LOCALAPPDATA = join(tmp, "AppData", "Local");
  process.env.USERPROFILE = tmp;
  process.env.OPENCODEX_HOME = tmp;
  process.env.KIRO_REGION = "us-east-1";
  delete process.env.KIRO_API_REGION;
  delete process.env.KIRO_PROFILE_ARN;
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
  if (origLocalAppData === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = origLocalAppData;
  if (origUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = origUserProfile;
  if (origRegion === undefined) delete process.env.KIRO_REGION; else process.env.KIRO_REGION = origRegion;
  if (origApiRegion === undefined) delete process.env.KIRO_API_REGION; else process.env.KIRO_API_REGION = origApiRegion;
  if (origArn === undefined) delete process.env.KIRO_PROFILE_ARN; else process.env.KIRO_PROFILE_ARN = origArn;
  if (origOcxHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = origOcxHome;
  removeTreeWithRetry(tmp);
});

const provider = {
  adapter: "kiro",
  baseUrl: "https://runtime.us-east-1.kiro.dev",
  authMode: "oauth",
  apiKey: "tok-123",
} as unknown as OcxProviderConfig;

function parsedWith(context: OcxParsedRequest["_kiroAuthContext"]): OcxParsedRequest {
  const parsed = {
    modelId: "claude-sonnet-4.5",
    stream: true,
    options: {},
    context: { messages: [{ role: "user", content: "hi" }] },
  } as unknown as OcxParsedRequest;
  if (context) parsed._kiroAuthContext = context;
  return parsed;
}

async function buildBody(parsed: OcxParsedRequest): Promise<{
  headers: Record<string, string>;
  payload: { profileArn?: string; conversationState?: Record<string, unknown> };
}> {
  const request = await createKiroAdapter(provider).buildRequest(parsed);
  return { headers: request.headers, payload: JSON.parse(request.body) };
}

describe("kiro Builder ID request-scoped service profile", () => {
  test("a Builder ID account sends the service profile in both the payload and the header", async () => {
    const { headers, payload } = await buildBody(parsedWith({ apiRegion: "us-east-1", authType: "aws_sso_oidc" }));

    expect(payload.profileArn).toBe(KIRO_BUILDER_ID_SERVICE_PROFILE_ARN);
    expect(headers["x-amzn-kiro-profile-arn"]).toBe(KIRO_BUILDER_ID_SERVICE_PROFILE_ARN);
  });

  test("a Builder ID account stays on the CLI wire path despite carrying a profile ARN", async () => {
    const { headers, payload } = await buildBody(parsedWith({ apiRegion: "us-east-1", authType: "aws_sso_oidc" }));

    // The CLI envelope is identified by its accept type and its agent continuation fields; the IDE
    // envelope would instead negotiate the eventstream accept and set x-amzn-kiro-agent-mode.
    expect(headers.accept).toBe("*/*");
    expect(headers["x-amzn-kiro-agent-mode"]).toBeUndefined();
    const conversationState = payload.conversationState ?? {};
    expect(conversationState.agentTaskType).toBe("vibe");
    expect(typeof conversationState.agentContinuationId).toBe("string");
  });

  test("an enterprise account keeps its own profile and the IDE wire path", async () => {
    const own = "arn:aws:codewhisperer:eu-central-1:123456789012:profile/account-b";
    const { headers, payload } = await buildBody(parsedWith({ apiRegion: "eu-central-1", profileArn: own }));

    expect(payload.profileArn).toBe(own);
    expect(headers["x-amzn-kiro-profile-arn"]).toBe(own);
    expect(headers.accept).toBe("application/vnd.amazon.eventstream");
    expect(headers["x-amzn-kiro-agent-mode"]).toBe("vibe");
  });

  test("an SSO OIDC account that does own a profile ARN uses its own, not the fallback", async () => {
    const own = "arn:aws:codewhisperer:us-east-1:123456789012:profile/enterprise-sso";
    const { payload } = await buildBody(parsedWith({ authType: "aws_sso_oidc", profileArn: own }));

    expect(payload.profileArn).toBe(own);
  });

  test("a kiro_desktop account with no profile still sends none, preserving its actionable failure", async () => {
    const { headers, payload } = await buildBody(parsedWith({ apiRegion: "us-east-1", authType: "kiro_desktop" }));

    expect(payload.profileArn).toBeUndefined();
    expect(headers["x-amzn-kiro-profile-arn"]).toBeUndefined();
  });

  test("a Kiro API key never borrows the Builder ID service profile", async () => {
    const apiKeyProvider = { ...provider, authMode: "key", apiKey: "ksk_example" } as unknown as OcxProviderConfig;
    const parsed = parsedWith({ authType: "aws_sso_oidc" });

    const request = await createKiroAdapter(apiKeyProvider).buildRequest(parsed);
    const payload = JSON.parse(request.body) as { profileArn?: string };

    expect(payload.profileArn).toBeUndefined();
    expect(request.headers["x-amzn-kiro-profile-arn"]).toBeUndefined();
  });

  test("the fallback never becomes the account's identity, region, or stored metadata", async () => {
    const builderId = { authType: "aws_sso_oidc" as const, ssoRegion: "eu-central-1" };

    // The identity resolver keeps answering "this account owns no profile".
    expect(resolveKiroProfileArn(builderId)).toBeUndefined();
    expect(resolveKiroRequestProfileArn(builderId)).toBe(KIRO_BUILDER_ID_SERVICE_PROFILE_ARN);

    // Region inference must not be pinned to the fallback's us-east-1.
    expect(resolveKiroApiRegion(builderId)).toBe("eu-central-1");

    await saveCredential("kiro", {
      access: "stored-access",
      refresh: "stored-refresh",
      expires: Date.now() + 3_600_000,
      source: "local-cli",
      kiro: { ssoRegion: "us-east-1", apiRegion: "us-east-1", clientId: "client-id", clientSecret: "client-secret" },
    });

    const snapshot = await getValidAccessTokenSnapshot("kiro");
    expect(snapshot.kiro?.authType).toBe("aws_sso_oidc");
    expect(snapshot.kiro?.profileArn).toBeUndefined();

    // The request built from that snapshot carries the fallback...
    const { payload } = await buildBody(parsedWith({ ...snapshot.kiro }));
    expect(payload.profileArn).toBe(KIRO_BUILDER_ID_SERVICE_PROFILE_ARN);

    // ...while the on-disk credential store never learns about it. Asserting on the raw file rather
    // than a parsed view is deliberate: a leak through any unexpected key is still a leak.
    // OPENCODEX_HOME is the config dir itself, so the store lives at the tmp root.
    const authStorePath = join(tmp, "auth.json");
    expect(existsSync(authStorePath)).toBe(true);
    const stored = readFileSync(authStorePath, "utf8");
    expect(stored).not.toContain(KIRO_BUILDER_ID_SERVICE_PROFILE_ARN);
    expect(stored).not.toContain("638616132270");
  });

  test("a legacy credential predating authType still routes as Builder ID via its client pair", async () => {
    await saveCredential("kiro", {
      access: "stored-access",
      refresh: "stored-refresh",
      expires: Date.now() + 3_600_000,
      source: "local-cli",
      kiro: { clientId: "client-id", clientSecret: "client-secret" },
    });

    const snapshot = await getValidAccessTokenSnapshot("kiro");

    expect(snapshot.kiro?.authType).toBe("aws_sso_oidc");
    const { payload } = await buildBody(parsedWith({ ...snapshot.kiro }));
    expect(payload.profileArn).toBe(KIRO_BUILDER_ID_SERVICE_PROFILE_ARN);
  });

  test("an accountless Builder ID import sends the fallback inside the CLI envelope, not the IDE one", async () => {
    // Regression for the wire-path/resolver split: the auth type here comes from the local import,
    // never from _kiroAuthContext, so a guard that re-derived Builder ID from the request context
    // would send the fallback ARN while shaping the call as an enterprise IDE request.
    seedKiroCliBuilderIdSession();

    const parsed = parsedWith(undefined);
    expect(parsed._kiroAuthContext).toBeUndefined();

    const { headers, payload } = await buildBody(parsed);

    expect(payload.profileArn).toBe(KIRO_BUILDER_ID_SERVICE_PROFILE_ARN);
    expect(headers["x-amzn-kiro-profile-arn"]).toBe(KIRO_BUILDER_ID_SERVICE_PROFILE_ARN);
    expect(headers.accept).toBe("*/*");
    expect(headers["x-amzn-kiro-agent-mode"]).toBeUndefined();
  });
});
