/**
 * Activation: install the delivery sink so a detected reset actually reaches the operator.
 *
 * Separate from the poller because the two are independent. `pollSeconds: 0` is a supported
 * configuration — observe live quota refreshes, never probe on a timer — and in that mode the
 * sink must still be installed or detection would run its bookkeeping and deliver nowhere.
 *
 * The sink is what the wp3 seams gate on: with none installed, observeQuotaSnapshot returns
 * immediately and no baseline is even stored. So this module is the single switch that turns the
 * whole subsystem from inert to live, which is why it re-reads config on every event rather than
 * capturing it once — an operator who changes `kinds` should not have to restart.
 */

import type { QuotaResetEvent } from "./reset-detector";

let activated = false;

/**
 * Install the sink when config asks for it, and remove it when config no longer does.
 *
 * Idempotent and cheap to call repeatedly: the enable check is the mtime-cached resolver, not a
 * config parse. Returns whether a sink is now installed, for the caller's own reporting.
 */
export async function syncQuotaResetActivation(): Promise<boolean> {
  const [{ isQuotaResetNotificationEnabled }, observer] = await Promise.all([
    import("./reset-notify-config"),
    import("./reset-observer"),
  ]);

  if (!isQuotaResetNotificationEnabled()) {
    // Deliberately clears a previously installed sink. Disabling in config must actually stop
    // delivery on the next check, not merely stop new observations.
    if (activated) {
      observer.setQuotaResetSink(null);
      activated = false;
    }
    return false;
  }

  if (activated) return true;
  observer.setQuotaResetSink(dispatch);
  activated = true;
  return true;
}

/**
 * Hand one event to the sinks.
 *
 * Synchronous by signature (the observer contract) and fire-and-forget in body: delivery must
 * never delay the quota write that triggered it. The observer has already claimed the
 * idempotence key by the time this runs, so a failed delivery is not retried — see reset-sinks.
 *
 * Config is resolved HERE, per event, so a changed `kinds` list or webhook URL takes effect
 * without a restart.
 */
function dispatch(event: QuotaResetEvent): void {
  void (async () => {
    try {
      const [{ currentQuotaResetNotify }, { deliverQuotaResetEvent }] = await Promise.all([
        import("./reset-notify-config"),
        import("./reset-sinks"),
      ]);
      const config = currentQuotaResetNotify();
      if (!config.enabled) return;
      await deliverQuotaResetEvent(event, config);
    } catch {
      // Best-effort by contract. deliverQuotaResetEvent does not reject, so reaching here means
      // the import itself failed, which the next event will retry.
    }
  })();
}

/** Test-only: forget activation state so a suite can re-activate against fresh config. */
export function resetQuotaResetActivationForTests(): void {
  activated = false;
}

/** Test-only: whether this module currently believes a sink is installed. */
export function isQuotaResetActivatedForTests(): boolean {
  return activated;
}
