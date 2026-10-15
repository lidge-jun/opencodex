/**
 * The one destination a DeepSeek Harness account token may reach. Kept free of adapter imports so
 * config validation can enforce the same pin the adapter applies at send time.
 */
export const DSH_ACCOUNT_DEFAULT_MESSAGES_URL = "https://api.deepseek.com/anthropic/v1/messages";

export function resolveDshAccountMessagesUrl(baseUrl?: string): string {
  if (!baseUrl || !baseUrl.trim()) {
    return DSH_ACCOUNT_DEFAULT_MESSAGES_URL;
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl.trim());
  } catch {
    throw new Error(`Untrusted dsh-account destination: "${baseUrl}". DSH credentials may only be transmitted to https://api.deepseek.com`);
  }

  // Pin protocol and hostname strictly to official DeepSeek API endpoint
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "api.deepseek.com") {
    throw new Error(
      `Untrusted dsh-account destination host: "${parsed.hostname}". DSH credentials may only be transmitted to https://api.deepseek.com`,
    );
  }

  const pathname = parsed.pathname.replace(/\/+$/, "");
  if (!pathname || pathname === "" || pathname === "/anthropic" || pathname === "/anthropic/v1" || pathname === "/anthropic/v1/messages") {
    return DSH_ACCOUNT_DEFAULT_MESSAGES_URL;
  }

  throw new Error(`Untrusted dsh-account destination path: "${parsed.pathname}". Expected /anthropic/v1/messages.`);
}
