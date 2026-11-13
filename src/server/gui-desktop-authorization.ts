import { createHash } from "node:crypto";
import { desktopGuiBinding, desktopGuiOrigin, hasDesktopForwardingHeaders } from "../lib/desktop-gui-origin";
import type { OcxConfig } from "../types";
import { managementRequestOrigin } from "./auth-cors";
import type { GuiSessionRecord, GuiSessionState } from "./gui-session";

export const DESKTOP_AUTHORIZATION_PATH = "/api/codex/desktop-compatibility/authorization";
const TTL = 5 * 60_000;
const authorities = new WeakMap<GuiSessionRecord, { expiresAt: number; binding: string }>();

/** A scope on the existing record: neither pairing issuance nor data-key disclosure changes. */
export function authorizeDesktopSession(req: Request, config: OcxConfig, state: GuiSessionState, session: GuiSessionRecord, grant: string): boolean {
  if (!/^ocx_pair_[A-Za-z0-9_-]{43}$/.test(grant) || req.method !== "POST"
    || new URL(req.url).pathname !== DESKTOP_AUTHORIZATION_PATH || new URL(req.url).search
    || hasDesktopForwardingHeaders(req) || desktopGuiOrigin(config, session.serverOrigin) !== session.serverOrigin
    || session.browserOrigin !== session.serverOrigin || req.headers.get("Origin") !== session.serverOrigin
    || managementRequestOrigin(req, config) !== session.serverOrigin
    || !(session.issuance === "loopback" || session.issuance === "pairing" && session.localPairing)) return false;
  const digest = createHash("sha256").update(grant).digest("base64url");
  const record = state.pairingGrants.get(digest), now = Date.now();
  if (!record?.desktopPurpose || record.desktopBinding !== desktopGuiBinding(config) || record.expiresAt <= now || record.serverOrigin !== session.serverOrigin
    || record.browserOrigin !== session.browserOrigin) return false;
  state.pairingGrants.delete(digest);
  authorities.set(session, { expiresAt: Math.min(now + TTL, session.expiresAt), binding: desktopGuiBinding(config) });
  return true;
}

export function desktopSessionAuthorized(req: Request, config: OcxConfig, session: GuiSessionRecord): boolean {
  const authority = authorities.get(session);
  if (!authority) return false;
  if (authority.expiresAt <= Date.now() || authority.binding !== desktopGuiBinding(config)
    || desktopGuiOrigin(config, session.serverOrigin) !== session.serverOrigin) {
    authorities.delete(session); return false;
  }
  return !hasDesktopForwardingHeaders(req);
}
