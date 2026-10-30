/** Acquire stats with { bigint: true }; never widen a Number to form an identity. */
export type FileIdentity = Readonly<{ dev: bigint; ino: bigint }>;

export function sameFileIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

export function fileIdentityKey(id: FileIdentity): string {
  return `${id.dev}:${id.ino}`;
}
