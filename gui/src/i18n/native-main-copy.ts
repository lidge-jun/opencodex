import type { Locale } from "./catalogs";
import { NATIVE_MAIN_TRANSLATIONS, type NativeMainTKey } from "./native-main-translations";

export type NativeMainTFn = (key: NativeMainTKey, vars?: Record<string, string | number>) => string;

/** Closed, nine-locale namespace like the adjacent Log Guard label modules.
 * Keep these keys out of the global catalog contract used by existing screens.
 */
export function nativeMainTranslator(locale: Locale): NativeMainTFn {
  return (key, vars) => {
    let result: string = NATIVE_MAIN_TRANSLATIONS[locale][key];
    for (const [name, value] of Object.entries(vars ?? {})) {
      result = result.split(`{${name}}`).join(String(value));
    }
    return result;
  };
}
