import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "./i18n/shared";
import { requestCodexRestart } from "./codex-restart";
import type { CodexRestartCode } from "./codex-restart";
import { confirmAction } from "./action-dialogs";
import type { NoticeTone } from "./ui";

export interface CodexRestartController {
  restarting: boolean;
  /**
   * Resolves to the response code, or null when the user declined the consent gate or
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
  /**
   * Where the outcome is shown. Required, and deliberately not defaulted: this used to
   * be `alert()`, which draws nothing inside the app, so every result — including a
   * partial stop that left app-servers running — was reported to no one. A consumer that
   * forgets to render it now fails to compile instead of failing silently.
   */
  report: (message: string, tone: NoticeTone) => void;
}

/** True when the outcome means nothing stale is left running. */
export function isRestartSettled(code: CodexRestartCode): boolean {
  return code === "stopped" || code === "nothing_running";
}

/**
 * Shared restart action for the sidebar and the models page.
 *
 * The consent gate is not ceremony: stopping an app-server can interrupt a Codex turn
 * that is running right now. That is precisely the consent the startup path
 * refuses to assume on the user's behalf (src/codex/app-server-processes.ts),
 * and a dashboard click is where the user gives it.
 *
 * It is an in-page dialog rather than `confirm()` because the app's webview implements
 * no JavaScript panel delegate: `confirm()` returned false there without drawing
 * anything, so this button took its early return on every click and did nothing at all.
 */
export function useCodexRestart(
  apiBase: string,
  options: CodexRestartOptions,
): CodexRestartController {
  const { t } = useI18n();
  const [restarting, setRestarting] = useState(false);
  // The request outlives a navigation away from the page that started it, so the
  // completion path must not touch state after unmount.
  const mounted = useRef(true);
  const onSettled = useRef(options.onSettled);
  const report = useRef(options.report);

  useEffect(() => {
    // Written in an effect, not during render: a ref assignment in the render
    // body is exactly what the react-compiler lint forbids.
    onSettled.current = options.onSettled;
    report.current = options.report;
  }, [options.onSettled, options.report]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const restart = useCallback(async (): Promise<CodexRestartCode | null> => {
    const consented = await confirmAction({
      message: t("dash.codexRestartConfirm"),
      confirmLabel: t("dash.codexRestart"),
      tone: "danger",
    });
    if (!consented) return null;
    setRestarting(true);
    const outcome = await requestCodexRestart(apiBase, {
      formatFailure: status => t("dash.codexRestartFailed", { status: String(status) }),
      formatUnreachable: () => t("dash.codexRestartUnreachable"),
      formatTimeout: () => t("dash.codexRestartTimeout"),
      formatMalformed: () => t("dash.codexRestartMalformed"),
    });
    if (mounted.current) setRestarting(false);

    if (!outcome.ok) {
      report.current(outcome.message, "err");
      return null;
    }

    const result = outcome.result;
    if (result.code === "stopped") {
      report.current(t("dash.codexRestartDone", { count: String(result.stopped.length) }), "ok");
    } else if (result.code === "nothing_running") {
      report.current(t("dash.codexRestartNothing"), "ok");
    } else if (result.code === "enumeration_unavailable") {
      report.current(t("dash.codexRestartUnknown"), "warn");
    } else {
      // Degraded, not failed: something is still running, so it must not read as success.
      report.current(t("dash.codexRestartPartial", { count: String(result.surviving.length) }), "warn");
    }

    // Only while mounted: a settled callback typically starts a refresh fetch,
    // and firing it from a page the user already left is work nobody reads.
    if (mounted.current && isRestartSettled(result.code)) onSettled.current?.(result.code);
    return result.code;
  }, [apiBase, t]);

  return { restarting, restart };
}
