// Records keyed by server- or user-supplied IDs can be asked for `__proto__`, `constructor`,
// or `toString`. A plain `record[key]` read then returns an inherited Object.prototype member
// instead of `undefined` — a function where the caller expects a string or a number.
export function ownRecordValue<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}
