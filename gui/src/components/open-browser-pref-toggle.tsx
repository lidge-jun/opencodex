import { useState } from "react";
import { useT } from "../i18n/shared";
import { readOpenBrowserPref, writeOpenBrowserPref } from "../oauth-open-browser-pref";

/**
 * The operator's answer to "should the proxy open a browser for me?"
 *
 * It sits next to the button that STARTS a login, not inside the waiting state,
 * because the request carries the choice — a toggle shown after the browser has
 * already been launched would be advice for next time rather than a control.
 *
 * Unchecking it is what makes a different Chrome profile reachable: the login
 * still starts, the authorization URL is still returned and displayed, and
 * nothing is spawned on the proxy's machine, so the operator opens the link
 * wherever they actually want to be signed in.
 */
/**
 * `serverDefault` is the persisted `oauthOpenBrowser` when the caller already
 * has it. This component deliberately does **not** fetch it: an auth panel that
 * quietly issued its own `/api/settings` request would make every surrounding
 * surface's request accounting wrong, and it did — it broke the account-import
 * tests, which assert exactly how many calls a selection makes.
 *
 * Not fetching costs nothing that matters. With no local preference the request
 * omits `openBrowser` entirely, so the persisted setting still governs what the
 * proxy actually does; only the initial checkbox rendering falls back to the
 * historical auto-open.
 */
export function OpenBrowserPrefToggle({ serverDefault = true }: { serverDefault?: boolean }) {
  const t = useT();
  const [choice, setChoice] = useState<boolean | undefined>(readOpenBrowserPref);
  const open = choice ?? serverDefault;

  return (
    <label className="open-browser-pref">
      <input
        type="checkbox"
        checked={!open}
        onChange={e => {
          const next = !e.target.checked;
          setChoice(next);
          writeOpenBrowserPref(next);
        }}
      />
      <span className="open-browser-pref-copy">
        <span className="text-label">{t("prov.dontOpenBrowser")}</span>
        <span className="muted text-label">{t("prov.dontOpenBrowserHint")}</span>
      </span>
    </label>
  );
}
