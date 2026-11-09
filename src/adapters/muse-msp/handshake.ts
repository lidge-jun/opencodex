import { MuseMspConnection, MuseMspError } from "./connection";

interface HandshakeResult {
  serverVersion: string;
  schemaVersion: number;
  sessionDurability: "ephemeral" | "durable";
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Check the current credential lane; this does not establish subscription eligibility. */
export async function requireMuseAccountLogin(connection: MuseMspConnection, options: { timeoutMs: number; signal?: AbortSignal }): Promise<void> {
  const account = await connection.request("account/read", {}, options);
  if (!record(account) || account.state !== "accountLogin") throw new MuseMspError("account_login_required");
}

/** Negotiate the capability the tool bridge needs before opening any session. */
export async function initializeMuseMsp(
  connection: MuseMspConnection,
  options: { timeoutMs: number; signal?: AbortSignal; requireEphemeral: boolean; requireAccountLogin?: true },
): Promise<HandshakeResult> {
  try {
    const result = await connection.request("initialize", {
      clientInfo: { name: "opencodex", version: "1" },
      capabilities: { requestedCapabilities: ["sessionMcp"], ...(options.requireAccountLogin ? { experimentalApi: true } : {}) },
    }, options);
    if (!record(result) || !record(result.serverInfo) || typeof result.serverInfo.version !== "string" ||
        !result.serverInfo.version.trim() || !record(result.schema) ||
        !Number.isSafeInteger(result.schema.version) || (result.schema.version as number) !== 1 ||
        !Array.isArray(result.grantedCapabilities) || !result.grantedCapabilities.includes("sessionMcp") ||
        (result.sessionDurability !== "ephemeral" && result.sessionDurability !== "durable")) {
      throw new MuseMspError("incompatible_host");
    }
    if (options.requireEphemeral && result.sessionDurability !== "ephemeral") {
      throw new MuseMspError("durable_session_refused");
    }
    if (options.requireAccountLogin && result.experimentalApi !== true) throw new MuseMspError("account_probe_unavailable");
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true; clearTimeout(timeout); options.signal?.removeEventListener("abort", aborted);
        if (error !== undefined) reject(error); else resolve();
      };
      const timeout = setTimeout(() => finish(new MuseMspError("timeout")), options.timeoutMs);
      const aborted = () => finish(new MuseMspError("cancelled"));
      options.signal?.addEventListener("abort", aborted, { once: true });
      if (options.signal?.aborted) { aborted(); return; }
      connection.notify("initialized").then(() => finish(), finish);
    });
    if (options.requireAccountLogin) {
      await requireMuseAccountLogin(connection, options);
    }
    return {
      serverVersion: result.serverInfo.version,
      schemaVersion: result.schema.version as number,
      sessionDurability: result.sessionDurability,
    };
  } catch (error) {
    connection.close();
    throw error;
  }
}
