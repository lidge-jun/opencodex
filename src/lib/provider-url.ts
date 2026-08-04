/** Strip credentials and non-routing URL components before displaying a provider URL. */
export function publicProviderBaseUrl(baseUrl: string): string {
  try {
    const parsed = new URL(baseUrl.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "(invalid URL)";
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, baseUrl.endsWith("/") ? "/" : "");
  } catch {
    return "(invalid URL)";
  }
}
