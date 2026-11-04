import { M365_COPILOT_WEB_URL, M365_COPILOT_WEB_COOKIE_NAMES, normalizeM365WebSession } from "../providers/m365-copilot-discovery";
import type { M365CopilotWebSession } from "./types";

interface BrowserCommands { command(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<any> }
export async function readM365BrowserWebSession(browser: BrowserCommands, context: string, signal: AbortSignal, firefox = false): Promise<M365CopilotWebSession> {
  const expression = "(()=>{const r=window.__staticRouterHydrationData?.loaderData?.root;const a=r?.store?.accountInfo;return a?.objectId&&a?.tenantId&&r?.__queryState?.queries?.some(q=>q.state?.data?.bizchatAsAgentGpt?.clientPreferences?.modelSelectorMetadata)?a.objectId+'@'+a.tenantId:''})()";
  if (firefox) await browser.command("browsingContext.navigate", { context, url: M365_COPILOT_WEB_URL, wait: "none" });
  else await browser.command("Page.navigate", { url: M365_COPILOT_WEB_URL }, context);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const result = await (firefox
      ? browser.command("script.evaluate", { expression, target: { context }, awaitPromise: false })
      : browser.command("Runtime.evaluate", { expression, returnByValue: true }, context)).catch(() => null);
    const accountId = result?.result?.value;
    if (typeof accountId === "string" && accountId) {
      const { cookies } = await (firefox
        ? browser.command("storage.getCookies", { partition: { type: "context", context } })
        : browser.command("Network.getCookies", { urls: [M365_COPILOT_WEB_URL] }, context));
      const cookie = (Array.isArray(cookies) ? cookies : []).filter(c =>
        ["copilot.cloud.microsoft", ".copilot.cloud.microsoft"].includes(c.domain)
        && c.secure === true && c.path === "/" && M365_COPILOT_WEB_COOKIE_NAMES.test(c.name))
        .map(c => c.name + "=" + (firefox ? c.value?.value : c.value)).join("; ");
      const session = normalizeM365WebSession({ cookie, accountId });
      if (session) return session;
    }
    await Bun.sleep(250);
  }
  throw new Error("Microsoft 365 Copilot web sign-in did not expose a work-account model picker; retry login");
}
