import type { ChildProcess } from "node:child_process";
import type { EventEmitter } from "node:events";

export declare function protectOrchestratedWorkerSignals(): void;

export declare function waitForOrchestratedChild(child: ChildProcess, options?: {
  signals?: EventEmitter;
  timeoutMs?: number;
  overrunMs?: number;
  setTimer?: (callback: () => void, timeoutMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}): Promise<{ confirmed: boolean; code: number | null; signal: NodeJS.Signals | null; reason?: "overrun" }>;
