import { M365_COPILOT_WEB_URL, M365_COPILOT_WEB_COOKIE_NAMES, m365BootstrapAccountId, normalizeM365WebSession } from "../providers/m365-copilot-discovery";
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
  + "if(!r.ok||!r.body||new URL(r.url).origin!==" + M365_WEB_ORIGIN + "){c.abort();return''}"
  + "const rd=r.body.getReader(),d=new TextDecoder();let s='',n=0;"
  + "for(;;){const{done,value}=await rd.read();if(done)break;n+=value.byteLength;"
  + "if(n>" + M365_CHAT_HTML_MAX_BYTES + "){c.abort();return''}s+=d.decode(value,{stream:true})}"
  + "return s+d.decode()}catch{return''}finally{clearTimeout(t)}})():''";
const pageAccountExpression = "(()=>{if(location.origin!==" + M365_WEB_ORIGIN + ")return'';const a=window.__staticRouterHydrationData?.loaderData?.root?.store?.accountInfo;"
  + "return a?.objectId&&a?.tenantId?a.objectId+'@'+a.tenantId:''})()";

async function browserAccountId(browser: BrowserCommands, context: string): Promise<string> {
  const result = await browser.command("Runtime.evaluate", { expression: pageAccountExpression, returnByValue: true }, context).catch(() => null);
  return typeof result?.result?.value === "string" ? result.result.value : "";
}

async function htmlAccountId(browser: BrowserCommands, context: string, signal: AbortSignal): Promise<string> {
  const page = await browser.command("Runtime.evaluate", { expression: fetchChatHtml, awaitPromise: true, returnByValue: true }, context).catch(() => null);
  // The fallback fetch can outlive a cancelled login; never read identity after an abort.
  signal.throwIfAborted();
  return typeof page?.result?.value === "string" ? m365BootstrapAccountId(page.result.value) : "";
}

function chatCookieHeader(cookies: unknown): string {
  return (Array.isArray(cookies) ? cookies : []).filter(c =>
    ["copilot.cloud.microsoft", ".copilot.cloud.microsoft"].includes(c.domain)
    && c.secure === true && c.path === "/" && M365_COPILOT_WEB_COOKIE_NAMES.test(c.name))
    .map(c => c.name + "=" + c.value).join("; ");
}

export async function readM365BrowserWebSession(browser: BrowserCommands, context: string, signal: AbortSignal, expectedAccountId?: string): Promise<M365CopilotWebSession> {
  await browser.command("Page.navigate", { url: M365_COPILOT_WEB_URL }, context);
  const deadline = Date.now() + 120_000;
  // A cookie must be accompanied by an independently observed web-account identity.
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const cookies = await browser.command("Network.getCookies", { urls: [M365_COPILOT_WEB_URL] }, context).then(result => result?.cookies).catch(() => undefined);
    signal.throwIfAborted();
    const cookie = chatCookieHeader(cookies);
    if (cookie) {
      const accountId = await browserAccountId(browser, context) || await htmlAccountId(browser, context, signal);
      signal.throwIfAborted();
      if (accountId && expectedAccountId && accountId.toLowerCase() !== expectedAccountId.toLowerCase()) throw new Error("Microsoft 365 Copilot web sign-in account mismatch");
      const session = normalizeM365WebSession({ cookie, accountId });
      if (session) return session;
    }
    await Bun.sleep(1_000);
  }
  throw new Error("Microsoft 365 Copilot web sign-in did not reach its chat session; retry login");
}
