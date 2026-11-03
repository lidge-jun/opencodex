/** Acquire stats with { bigint: true }; never widen a Number to form an identity. */
export type FileIdentity = Readonly<{ dev: bigint; ino: bigint }>;

/** Matches the numeric stat's *Ms value, so a bigint observation can be compared with a numeric or persisted one. */
export function statTimeMs(ns: bigint): number {
  return Number(ns / 1_000_000_000n) * 1e3 + Number(ns % 1_000_000_000n) / 1e6;
}

export function sameFileIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

export function fileIdentityKey(id: FileIdentity): string {
  return `${id.dev}:${id.ino}`;
}
