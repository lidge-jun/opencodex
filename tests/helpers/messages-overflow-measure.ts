type Item = { n: number; ms: number; max: number; errors: number };
const items = new Map<string, Item>();

export function measure<T>(name: string, action: () => T): T {
  const start = performance.now();
  let failed = false;
  try { return action(); }
  catch (error) { failed = true; throw error; }
  finally {
    const elapsed = performance.now() - start;
    const item = items.get(name) ?? { n: 0, ms: 0, max: 0, errors: 0 };
    item.n++; item.ms += elapsed; item.max = Math.max(item.max, elapsed); item.errors += Number(failed);
    items.set(name, item);
  }
}

export function flushMeasurements(row: string) {
  const entries = Object.fromEntries([...items].map(([key, value]) => [key, { ...value, ms: +value.ms.toFixed(1), max: +value.max.toFixed(1) }]));
  items.clear();
  process.stderr.write(`OVERFLOW_DIAG ${JSON.stringify({ phase: "subphases", row, entries })}\n`);
}
