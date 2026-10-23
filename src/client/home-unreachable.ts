/**
 * OCX-11: the stable answer a Remote Link Child or Hub client gives when its Home cannot be
 * reached. The relay keeps its status, `error` string and retry semantics; `code` and
 * `message` are added so callers (Codex, GOAT) read one contract. The client runtime has no
 * provider dispatch, so nothing is ever served from this device's local providers. Whether GOAT
 * may move the work to them is the Home's per-device `fallback.devices.<id>.localFallback`.
 */
export const HOME_UNREACHABLE_CODE = "home_unreachable";

export const HOME_UNREACHABLE_MESSAGE = "The Home is unreachable, and OpenCodex did not serve this request "
  + "from this device's local providers. Retry once the Home is back. Allowing local fallback for this "
  + "device is set on the Home: ocx fallback local on --device <id>.";

export function homeUnreachableBody(error: string): { error: string; code: string; message: string } {
  return { error, code: HOME_UNREACHABLE_CODE, message: HOME_UNREACHABLE_MESSAGE };
}
