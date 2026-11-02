export interface OrchestratedExpect {
  home: string;
  cliRoot: string;
  servingRoot: string | null;
  runtimePid: number | null;
  planToken: string;
}
export declare function encodeOrchestratedExpect(value: OrchestratedExpect): string;
export declare function decodeOrchestratedExpect(encoded: string): OrchestratedExpect;
export declare function createOrchestratedChildSession(options: {
  home: string;
  resultPath: string;
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
  finish(outcome: { phase: "installed"; activeRoot: string } | { phase: "failed"; error?: string; rollbackPerformed?: boolean }): void;
};
export declare function createLegacyUpdateSession(options: { home: string }): ReturnType<typeof createOrchestratedChildSession>;
