import { isLinkConnectionGeneration } from "../link/relay-auth";
import { validateReadyzBody, type LiveProxy } from "../server/proxy-liveness";

const STATUS_LINK_TIMEOUT_MS = 2_000;

/**
 * `ocx status --json` `link.connectionGeneration` on a Remote Link Child: the tunnel connection the
 * live client runtime names in a ready `/readyz`. It changes on every tunnel connect and on a
 * runtime restart. Undefined, never null, when no client runtime answers ready with a valid
 * value; it never fails the status report.
 */
export async function collectLinkConnectionGeneration(
  live: Pick<LiveProxy, "pid" | "port" | "role"> | null,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<string | undefined> {
  if (!live || live.role !== "client") return undefined;
  try {
    const response = await (deps.fetchImpl ?? fetch)(`http://127.0.0.1:${live.port}/readyz`, {
      signal: AbortSignal.timeout(STATUS_LINK_TIMEOUT_MS), redirect: "manual",
    });
    if (response.status !== 200) return undefined;
    const body: unknown = await response.json();
    if (!validateReadyzBody(body, live.port, live.pid === null ? {} : { expectedPid: live.pid })?.ready) return undefined;
    const link = (body as { link?: unknown }).link;
    const generation = link && typeof link === "object" ? (link as { connectionGeneration?: unknown }).connectionGeneration : undefined;
    return isLinkConnectionGeneration(generation) ? generation : undefined;
  } catch { return undefined; }
}
