import type { OcxConfig } from "../types";
import { DESKTOP_GUI_PAIR_PATH, GUI_PAIR_BROWSER_ORIGIN_HEADER, GUI_PAIR_CAPABILITY_HEADER, standaloneGuiPairingOrigin } from "../lib/gui-pair-capability";
import { desktopGuiOrigin, hasDesktopForwardingHeaders } from "../lib/desktop-gui-origin";
import { consumeGuiPairIntent, GUI_PAIR_INTENT_HEADER } from "../lib/gui-pair-intent";
import { createGuiPairingGrant, type GuiSessionState } from "./gui-session";

export class GuiPairingIntentRequiredError extends Error {
  constructor() {
    super("Standalone GUI pairing requires a fresh local CLI intent");
    this.name = "GuiPairingIntentRequiredError";
  }
}

/** The serving route must authenticate the existing process-bound capability first. */
export function deliverGuiPairingGrant(req: Request, config: OcxConfig, state: GuiSessionState) {
  const origin = req.headers.get(GUI_PAIR_BROWSER_ORIGIN_HEADER) ?? "";
  const desktop = new URL(req.url).pathname === DESKTOP_GUI_PAIR_PATH;
  if (desktop && (hasDesktopForwardingHeaders(req) || desktopGuiOrigin(config, origin) !== origin)) throw new GuiPairingIntentRequiredError();
  if (config.runtimeRole !== "hub") {
    if ((desktop ? desktopGuiOrigin(config, origin) : standaloneGuiPairingOrigin(config)) !== origin
      || !consumeGuiPairIntent(req.headers.get(GUI_PAIR_CAPABILITY_HEADER), req.headers.get(GUI_PAIR_INTENT_HEADER))) {
      throw new GuiPairingIntentRequiredError();
    }
  }
  return createGuiPairingGrant(origin, config, state, Date.now(), desktop);
}
