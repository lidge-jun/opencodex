export interface OrchestratedExpect {
  home: string;
  cliRoot: string;
  servingRoot: string | null;
  runtimePid: number | null;
  planToken: string;
}
export declare function encodeOrchestratedExpect(value: OrchestratedExpect): string;
export declare function decodeOrchestratedExpect(encoded: string): OrchestratedExpect;
export interface OrchestratedResultChannel {
  directory: string;
  resultPath: string;
  capability: string;
  read(): Record<string, unknown> | null;
  dispose(): void;
}
export declare function createOrchestratedResultChannel(): OrchestratedResultChannel;
export declare function issueOrchestratedResultCapability(path: string): { capability: string; identity: import("node:fs").BigIntStats };
export declare function createOrchestratedChildSession(options: {
  home: string;
  resultPath: string;
  resultCapability: string;
  expect: OrchestratedExpect;
  notAfter?: number;
  now?: () => number;
  pid?: number;
  verifyIdentity: () => boolean | Promise<boolean>;
}): {
  start(): { ok: true } | { ok: false; error: "sync-in-progress" | "update-in-flight" };
  finishPreflight(): void;
  enterMutation(): Promise<{ ok: true } | { ok: false; error: "sync-in-progress" | "update-in-flight" | "deadline-passed" | "plan-changed" }>;
  noteUntrackedInstaller(): void;
  confirmInstallerExit(): void;
  retainInstallerFence(): void;
  finish(outcome: ({ phase: "installed"; activeRoot: string } | { phase: "failed"; error?: string; rollbackPerformed?: boolean }) & { terminationConfirmed?: boolean }): void;
};
export declare function createLegacyUpdateSession(options: { home: string }): ReturnType<typeof createOrchestratedChildSession>;
