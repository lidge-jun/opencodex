import { M365_COPILOT_WEB_URL, M365_COPILOT_WEB_COOKIE_NAMES, normalizeM365WebSession, parseM365ModelBootstrap } from "../providers/m365-copilot-discovery";
import type { M365CopilotWebSession } from "./types";

interface BrowserCommands { command(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<any> }
// The web app deletes its hydration global after startup, so the server HTML is the fallback source.
// The page-side read is bounded like discovery (2 MiB) and in time, and it rejects a response whose
// final URL left the Copilot origin, so a huge, stalled or redirected body never reaches the parser.
const M365_CHAT_HTML_MAX_BYTES = 2 * 1024 * 1024;
const M365_CHAT_HTML_TIMEOUT_MS = 10_000;
const M365_WEB_ORIGIN = JSON.stringify(new URL(M365_COPILOT_WEB_URL).origin);
const fetchChatHtml = "location.origin===" + M365_WEB_ORIGIN + "?(async()=>{"
  + "const c=new AbortController(),t=setTimeout(()=>c.abort()," + M365_CHAT_HTML_TIMEOUT_MS + ");"
  + "try{const r=await fetch(" + JSON.stringify(M365_COPILOT_WEB_URL) + ",{credentials:'include',signal:c.signal});"
  + "if(!r.ok||!r.body||new URL(r.url).origin!==" + M365_WEB_ORIGIN + ")return'';"
  + "const rd=r.body.getReader(),d=new TextDecoder();let s='',n=0;"
  + "for(;;){const{done,value}=await rd.read();if(done)break;n+=value.byteLength;"
  + "if(n>" + M365_CHAT_HTML_MAX_BYTES + "){c.abort();return''}s+=d.decode(value,{stream:true})}"
  + "return s+d.decode()}catch{return''}finally{clearTimeout(t)}})():''";
function bootstrapAccountId(html: unknown) {
  if (typeof html !== "string" || !html) return "";
  try { return parseM365ModelBootstrap(html).accountId; } catch { return ""; }
}
export async function readM365BrowserWebSession(browser: BrowserCommands, context: string, signal: AbortSignal): Promise<M365CopilotWebSession> {
  const expression = "(()=>{const r=window.__staticRouterHydrationData?.loaderData?.root;const a=r?.store?.accountInfo;return a?.objectId&&a?.tenantId&&r?.__queryState?.queries?.some(q=>q.state?.data?.bizchatAsAgentGpt?.clientPreferences?.modelSelectorMetadata)?a.objectId+'@'+a.tenantId:''})()";
  await browser.command("Page.navigate", { url: M365_COPILOT_WEB_URL }, context);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const result = await browser.command("Runtime.evaluate", { expression, returnByValue: true }, context).catch(() => null);
    let accountId = result?.result?.value;
    if (typeof accountId !== "string" || !accountId) {
      const page = await browser.command("Runtime.evaluate", { expression: fetchChatHtml, awaitPromise: true, returnByValue: true }, context).catch(() => null);
      // The fallback fetch can outlive a cancelled login; never read cookies after an abort.
      signal.throwIfAborted();
      accountId = bootstrapAccountId(page?.result?.value);
    }
    if (accountId) {
      const { cookies } = await browser.command("Network.getCookies", { urls: [M365_COPILOT_WEB_URL] }, context);
      const cookie = (Array.isArray(cookies) ? cookies : []).filter(c =>
        ["copilot.cloud.microsoft", ".copilot.cloud.microsoft"].includes(c.domain)
        && c.secure === true && c.path === "/" && M365_COPILOT_WEB_COOKIE_NAMES.test(c.name))
        .map(c => c.name + "=" + c.value).join("; ");
      const session = normalizeM365WebSession({ cookie, accountId });
      if (session) return session;
    }
    await Bun.sleep(1_000);
  }
  throw new Error("Microsoft 365 Copilot web sign-in did not expose a work-account model picker; retry login");
}
