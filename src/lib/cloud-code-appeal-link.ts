const MAX_APPEAL_URL_LENGTH = 512;
// Check the literal authority as well: URL drops an explicit :443 and empty userinfo.
const APPEAL_AUTHORITY = /^https:\/\/(?:forms\.gle|support\.google\.com|docs\.google\.com)(?=[/?#]|$)/i;

export function normalizeCloudCodeAppealUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_APPEAL_URL_LENGTH
    || /[\s\\\p{C}]/u.test(value) || !APPEAL_AUTHORITY.test(value)) return;
  let url: URL;
  try { url = new URL(value); } catch { return; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return;
  switch (url.hostname) {
    case "docs.google.com":
      if (!url.pathname.startsWith("/forms/")) return;
      break;
    case "forms.gle":
      break;
    case "support.google.com":
      url.search = "";
      break;
    default:
      return;
  }
  url.hash = "";
  return url.href.length <= MAX_APPEAL_URL_LENGTH ? url.href : undefined;
}

export function normalizeCloudCodeAppealText(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 80 || /[<>\p{C}\p{Zl}\p{Zp}]/u.test(value)) return;
  return value.trim() || undefined;
}
