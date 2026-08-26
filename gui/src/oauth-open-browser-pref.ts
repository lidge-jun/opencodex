/**
 * Whether this browser wants the proxy to open a browser when a login starts.
 *
 * Client-side and remembered, because the choice belongs to where the human is
 * sitting, not to the machine running the proxy: the same proxy can be driven
 * from a laptop that wants the auto-open and from a tunnel where it is useless.
 *
 * **Deliberately tri-state.** `undefined` means "this operator has not
 * expressed a preference", and the request then omits `openBrowser` entirely so
 * the server-side setting decides. Sending a boolean unconditionally would make
 * a persisted `oauthOpenBrowser: false` dead on arrival — the request always
 * wins, so a GUI that always speaks would permanently overrule the config file.
 *
 * Reads never throw. A browser with storage disabled behaves as "no preference"
 * rather than losing the login.
 */
const KEY = "ocx.oauth.openBrowser";

export function readOpenBrowserPref(): boolean | undefined {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === "0") return false;
    if (raw === "1") return true;
    return undefined;
  } catch {
    return undefined;
  }
}

/** Spread into a login request body; contributes nothing when unset. */
export function openBrowserRequestField(): { openBrowser?: boolean } {
  const pref = readOpenBrowserPref();
  return pref === undefined ? {} : { openBrowser: pref };
}

export function writeOpenBrowserPref(open: boolean): void {
  try {
    window.localStorage.setItem(KEY, open ? "1" : "0");
  } catch {
    // A rejected write only costs the user the memory of the choice, not the choice.
  }
}
