import type { OcxConfig } from "../types";
import { GUI_PAIR_BROWSER_ORIGIN_HEADER, GUI_PAIR_CAPABILITY_HEADER, standaloneGuiPairingOrigin } from "../lib/gui-pair-capability";
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
  if (config.runtimeRole !== "hub") {
    if (standaloneGuiPairingOrigin(config) !== origin
      || !consumeGuiPairIntent(req.headers.get(GUI_PAIR_CAPABILITY_HEADER), req.headers.get(GUI_PAIR_INTENT_HEADER))) {
      throw new GuiPairingIntentRequiredError();
    }
  }
  return createGuiPairingGrant(origin, config, state);
}
