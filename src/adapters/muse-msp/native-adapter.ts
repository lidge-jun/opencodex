import type { IncomingMeta, ProviderAdapter } from "../base";
import type { MuseToolResult } from "./tool-result";
import { MuseBudgetSlot, withMuseBudgetLease } from "./budget-slot";
import { MuseMspError } from "./connection";
import { createMuseMspAdapter } from "./adapter";
import type { MuseMspRunner } from "./runner";

/**
 * Unregistered native-MSP composition. As for existing coding-agent CLIs, each
 * dispatched segment is one opaque admission, not a physical request counter.
 * The caller owns the runner and must close it when the route is retired.
 */
export function createMuseNativeAdapter(runner: Pick<MuseMspRunner, "run" | "onResponseRendered">,
  targetKey: string, timeoutMs = 60_000): ProviderAdapter {
  if (!targetKey || Buffer.byteLength(targetKey) > 4096) throw new MuseMspError("invalid_budget_target");
  return createMuseMspAdapter(runner, timeoutMs, {
    async run<T>(incoming: IncomingMeta, execute: (hooks?: { beforeDispatch?: () => void;
      beforeResultCommit?: (result: Readonly<MuseToolResult>) => void; beforeUserDispatch?: (text: string) => void }) => Promise<T>,
      context: { continuation: boolean; userContinuation: boolean }): Promise<T> {
      const slot = new MuseBudgetSlot();
      try {
        return await withMuseBudgetLease(slot, incoming, targetKey, async lease => {
          let finish: (() => void) | undefined;
          const admit = () => { if (finish) throw new MuseMspError("duplicate_segment_dispatch"); finish = lease.beginSend(); };
          const hooks = context.continuation ? { beforeResultCommit: admit } : context.userContinuation ? { beforeUserDispatch: admit } : { beforeDispatch: admit };
          try {
            const result = await execute(hooks);
            if (!finish) throw new MuseMspError("segment_not_admitted");
            return result;
          }
          finally { finish?.(); }
        });
      } finally { slot.close(); }
    },
  });
}
