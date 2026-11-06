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
  const counts = new Map<string, Map<string, { n: number; ms: number; max: number; failed: number; timeout: number; thrown: number }>>();
  const diag = process.env.OCX_OVERFLOW_DIAG === "1";
  const record = (row: string, kind: string, execution: string, args: unknown[], elapsed: number, result: { success?: boolean; exitCode?: number | null; exitedDueToTimeout?: boolean } | undefined, thrown: boolean) => {
    if (!diag) return;
    const cmd = Array.isArray(args[0]) ? args[0] : (args[0] as { cmd?: unknown[] })?.cmd ?? [];
    const flags = cmd.filter((part): part is string => typeof part === "string" && /^\/(?:findsid|grant:r|inheritance:r|remove:g)$/i.test(part)).map(flag => flag.toLowerCase()).sort();
    const key = `${execution}:${kind}:${flags.join(",") || "other"}`;
    const byKind = counts.get(row) ?? new Map(); counts.set(row, byKind);
    const item = byKind.get(key) ?? { n: 0, ms: 0, max: 0, failed: 0, timeout: 0, thrown: 0 };
    item.n++; item.ms += elapsed; item.max = Math.max(item.max, elapsed); item.failed += Number(result?.success === false || (result?.exitCode != null && result.exitCode !== 0)); item.timeout += Number(result?.exitedDueToTimeout === true); item.thrown += Number(thrown);
    byKind.set(key, item);
  };
  const kindOf = (arg: unknown) => {
    const raw = Array.isArray(arg) ? arg[0] : (arg as { cmd?: string[] })?.cmd?.[0];
    const executable = typeof raw === "string" ? raw.split(/[\\/]/).pop()!.toLowerCase() : "unknown";
    return executable.includes("powershell") || executable === "pwsh.exe" ? "powershell" : executable === "icacls.exe" || executable === "icacls" ? "icacls" : "other";
  };
  const wrapped = ((...args: unknown[]) => {
    const started = diag ? performance.now() : 0;
    const kind = diag ? kindOf(args[0]) : "";
    const row = diag ? Reflect.get(globalThis, "__overflowDiagRow") ?? "startup" : "";
    const child = Reflect.apply(original, Bun, args) as ReturnType<typeof Bun.spawn>;
    try {
      const observed = Promise.resolve(child.exited).then(code => { record(row, kind, "async", args, performance.now() - started, { exitCode: code }, false); }, error => { failures.push(error); record(row, kind, "async", args, performance.now() - started, undefined, true); });
      pending.add(observed);
      void observed.then(() => pending.delete(observed));
    } catch (error) { failures.push(error); }
    return child;
  }) as typeof Bun.spawn;
  const wrappedSync = ((...args: unknown[]) => {
    const started = performance.now();
    const row = Reflect.get(globalThis, "__overflowDiagRow") ?? "startup";
    let result: ReturnType<typeof Bun.spawnSync> | undefined; let thrown = false;
    try { result = Reflect.apply(originalSync, Bun, args) as ReturnType<typeof Bun.spawnSync>; return result; }
    catch (error) { thrown = true; throw error; }
    finally { record(row, kindOf(args[0]), "sync", args, performance.now() - started, result, thrown); }
  }) as typeof Bun.spawnSync;
  Bun.spawn = wrapped;
  if (diag) Bun.spawnSync = wrappedSync;
  return {
    flush(row: string) {
      if (!diag) return;
      const entries = Object.fromEntries([...(counts.get(row) ?? new Map())].map(([key, value]) => [key, { ...value, ms: +value.ms.toFixed(1), max: +value.max.toFixed(1) }]));
      counts.delete(row);
      process.stderr.write(`OVERFLOW_DIAG ${JSON.stringify({ phase: "spawn_summary", row, entries })}\n`);
    },
    flushAll() {
      if (!diag) return;
      for (const row of counts.keys()) this.flush(row);
    },
    async drain() {
      while (pending.size) await Promise.all([...pending]);
      if (failures.length) throw new AggregateError(failures, "overflow subprocess exit was not observed");
    },
    restore() {
      if (Bun.spawn !== wrapped) throw new Error("overflow subprocess tracker was replaced");
      if (diag && Bun.spawnSync !== wrappedSync) throw new Error("overflow synchronous subprocess tracker was replaced");
      Bun.spawn = original;
      if (diag) Bun.spawnSync = originalSync;
    },
  };
}
