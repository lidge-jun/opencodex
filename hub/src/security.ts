import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "hubapi_session";
export const CSRF_COOKIE = "hubapi_csrf";
export const CSRF_HEADER = "x-hubapi-csrf-token";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COMMON_PASSWORDS = new Set([
  "123456789012",
  "administrator",
  "changeme12345",
  "letmein123456",
  "password1234",
  "password12345",
  "qwerty123456",
  "welcome123456",
]);

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().normalize("NFKC").toLowerCase();
  if (normalized.length < 3 || normalized.length > 254 || !EMAIL_PATTERN.test(normalized)) return null;
  return normalized;
}

export function validPassword(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 12 || value.length > 1024) return false;
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  if (normalized.length < 12) return false;
  if (COMMON_PASSWORDS.has(normalized)) return false;
  if (/^(.)\1{11,}$/.test(normalized)) return false;
  return true;
}

export function randomToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

export function randomReference(prefix: string): string {
  return `${prefix}${randomBytes(9).toString("base64url")}`;
}

export function hmacDigest(secret: string, domain: string, value: string): string {
  return createHmac("sha256", secret).update(`hubapi:${domain}:v1\0`).update(value).digest("base64url");
}

export function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function parseCookies(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const pair of header?.split(";") ?? []) {
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (name && !cookies.has(name)) cookies.set(name, value);
  }
  return cookies;
}

export function sessionCookie(token: string, secure: boolean, maxAgeSeconds: number): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    "Path=/hub",
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : "",
    `Max-Age=${maxAgeSeconds}`,
  ].filter(Boolean).join("; ");
}

export function csrfCookie(token: string, secure: boolean, maxAgeSeconds: number): string {
  return [
    `${CSRF_COOKIE}=${token}`,
    "Path=/hub",
    "SameSite=Lax",
    secure ? "Secure" : "",
    `Max-Age=${maxAgeSeconds}`,
  ].filter(Boolean).join("; ");
}

export function clearSessionCookie(secure: boolean): string {
  return [
    `${SESSION_COOKIE}=`,
    "Path=/hub",
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : "",
    "Max-Age=0",
  ].filter(Boolean).join("; ");
}

export function clearCsrfCookie(secure: boolean): string {
  return [
    `${CSRF_COOKIE}=`,
    "Path=/hub",
    "SameSite=Lax",
    secure ? "Secure" : "",
    "Max-Age=0",
  ].filter(Boolean).join("; ");
}

export function securityHeaders(): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Referrer-Policy": "no-referrer",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}
