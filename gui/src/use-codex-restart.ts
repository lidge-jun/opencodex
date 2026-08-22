import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "./i18n/shared";
import { requestCodexRestart } from "./codex-restart";
import type { CodexRestartCode } from "./codex-restart";

export interface CodexRestartController {
  restarting: boolean;
  /**
   * Resolves to the response code, or null when the user declined the confirm or
   * the call failed. Callers that track staleness must treat BOTH `stopped` and
   * `nothing_running` as "no stale app-server remains" — the second is the race
   * where the target exited on its own, and refreshing on only the first would
   * leave a staleness banner up after a successful outcome.
   */
  restart: () => Promise<CodexRestartCode | null>;
}

export interface CodexRestartOptions {
  /**
   * Called after any outcome that means no stale app-server remains. This is how
   * a surface that renders staleness stays correct no matter which button the
   * user pressed — including the sidebar button, which knows nothing about the
   * models page.
   */
  onSettled?: (code: CodexRestartCode) => void;
}

/** True when the outcome means nothing stale is left running. */
export function isRestartSettled(code: CodexRestartCode): boolean {
  return code === "stopped" || code === "nothing_running";
}

/**
 * Shared restart action for the sidebar and the models page.
 *
 * The confirm is not ceremony: stopping an app-server can interrupt a Codex turn
 * that is running right now. That is precisely the consent the startup path
 * refuses to assume on the user's behalf (src/codex/app-server-processes.ts),
 * and a dashboard click is where the user gives it.
 */
export function useCodexRestart(
  apiBase: string,
  options: CodexRestartOptions = {},
): CodexRestartController {
  const { t } = useI18n();
  const [restarting, setRestarting] = useState(false);
  // The request outlives a navigation away from the page that started it, so the
  // completion path must not touch state after unmount.
  const mounted = useRef(true);
  const onSettled = useRef(options.onSettled);

  useEffect(() => {
    // Written in an effect, not during render: a ref assignment in the render
    // body is exactly what the react-compiler lint forbids.
    onSettled.current = options.onSettled;
  }, [options.onSettled]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const restart = useCallback(async (): Promise<CodexRestartCode | null> => {
    if (!confirm(t("dash.codexRestartConfirm"))) return null;
    setRestarting(true);
    const outcome = await requestCodexRestart(apiBase, {
      formatFailure: status => t("dash.codexRestartFailed", { status: String(status) }),
      formatUnreachable: () => t("dash.codexRestartUnreachable"),
      formatTimeout: () => t("dash.codexRestartTimeout"),
      formatMalformed: () => t("dash.codexRestartMalformed"),
    });
    if (mounted.current) setRestarting(false);

    if (!outcome.ok || !outcome.result) {
      alert(outcome.message);
      return null;
    }

    const result = outcome.result;
    if (result.code === "stopped") {
      alert(t("dash.codexRestartDone", { count: String(result.stopped.length) }));
    } else if (result.code === "nothing_running") {
      alert(t("dash.codexRestartNothing"));
    } else if (result.code === "enumeration_unavailable") {
      alert(t("dash.codexRestartUnknown"));
    } else {
      alert(t("dash.codexRestartPartial", { count: String(result.surviving.length) }));
    }

    // Only while mounted: a settled callback typically starts a refresh fetch,
    // and firing it from a page the user already left is work nobody reads.
    if (mounted.current && isRestartSettled(result.code)) onSettled.current?.(result.code);
    return result.code;
  }, [apiBase, t]);

  return { restarting, restart };
}

