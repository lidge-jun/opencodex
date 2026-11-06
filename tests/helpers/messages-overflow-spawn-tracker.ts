/**
 * Fixture-only observation of async Bun subprocesses. Some Windows read-only
 * ACL probes return on timeout before their PowerShell child has actually exited.
 * This wrapper preserves the real spawn and keeps its exit promise until joined.
 */
export function trackOverflowAsyncSpawns() {
  const original = Bun.spawn;
  const originalSync = Bun.spawnSync;
  const pending = new Set<Promise<void>>();
  const failures: unknown[] = [];
  const kindOf = (arg: unknown) => {
    const raw = Array.isArray(arg) ? arg[0] : (arg as { cmd?: string[] })?.cmd?.[0];
    const executable = typeof raw === "string" ? raw.split(/[\\/]/).pop()!.toLowerCase() : "unknown";
    return executable.includes("powershell") || executable === "pwsh.exe" ? "powershell" : executable === "icacls.exe" || executable === "icacls" ? "icacls" : "other";
  };
  const wrapped = ((...args: unknown[]) => {
    const started = performance.now();
    const kind = kindOf(args[0]);
    const row = Reflect.get(globalThis, "__overflowDiagRow") ?? "startup";
    const child = Reflect.apply(original, Bun, args) as ReturnType<typeof Bun.spawn>;
    try {
      const observed = Promise.resolve(child.exited).then(code => { if (process.env.OCX_OVERFLOW_DIAG === "1") process.stderr.write(`OVERFLOW_DIAG ${JSON.stringify({ phase: "async_spawn_exit", row, kind, elapsed_ms: +(performance.now() - started).toFixed(1), exit: code })}\n`); }, error => { failures.push(error); });
      pending.add(observed);
      void observed.then(() => pending.delete(observed));
    } catch (error) { failures.push(error); }
    return child;
  }) as typeof Bun.spawn;
  const wrappedSync = ((...args: unknown[]) => {
    const started = performance.now();
    try { return Reflect.apply(originalSync, Bun, args); }
    finally {
      if (process.env.OCX_OVERFLOW_DIAG === "1") process.stderr.write(`OVERFLOW_DIAG ${JSON.stringify({ phase: "sync_spawn_return", row: Reflect.get(globalThis, "__overflowDiagRow") ?? "startup", kind: kindOf(args[0]), elapsed_ms: +(performance.now() - started).toFixed(1) })}\n`);
    }
  }) as typeof Bun.spawnSync;
  Bun.spawn = wrapped;
  Bun.spawnSync = wrappedSync;
  return {
    async drain() {
      while (pending.size) await Promise.all([...pending]);
      if (failures.length) throw new AggregateError(failures, "overflow subprocess exit was not observed");
    },
    restore() {
      if (Bun.spawn !== wrapped) throw new Error("overflow subprocess tracker was replaced");
      if (Bun.spawnSync !== wrappedSync) throw new Error("overflow synchronous subprocess tracker was replaced");
      Bun.spawn = original;
      Bun.spawnSync = originalSync;
    },
  };
}
