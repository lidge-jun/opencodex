/**
 * Fixture-only observation of async Bun subprocesses. Some Windows read-only
 * ACL probes return on timeout before their PowerShell child has actually exited.
 * This wrapper preserves the real spawn and keeps its exit promise until joined.
 */
export function trackOverflowAsyncSpawns() {
  const original = Bun.spawn;
  const pending = new Set<Promise<void>>();
  const failures: unknown[] = [];
  const wrapped = ((...args: unknown[]) => {
    const child = Reflect.apply(original, Bun, args) as ReturnType<typeof Bun.spawn>;
    try {
      const observed = Promise.resolve(child.exited).then(() => {}, error => { failures.push(error); });
      pending.add(observed);
      void observed.then(() => pending.delete(observed));
    } catch (error) { failures.push(error); }
    return child;
  }) as typeof Bun.spawn;
  Bun.spawn = wrapped;
  return {
    async drain() {
      while (pending.size) await Promise.all([...pending]);
      if (failures.length) throw new AggregateError(failures, "overflow subprocess exit was not observed");
    },
    restore() {
      if (Bun.spawn !== wrapped) throw new Error("overflow subprocess tracker was replaced");
      Bun.spawn = original;
    },
  };
}
