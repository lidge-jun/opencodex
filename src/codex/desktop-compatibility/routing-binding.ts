import type { OcxConfig } from "../../types";

export interface NativeCompatibilityOwner { hostname: string; port: number; loopbackPort?: number; config: OcxConfig }
let owner: NativeCompatibilityOwner | null = null;
/** Bound sockets, not persisted desired ports, identify this process's native routing target. */
export function bindNativeCompatibilityOwner(value: NativeCompatibilityOwner): () => void {
  owner = value;
  return () => { if (owner === value) owner = null; };
}
export function nativeCompatibilityOwner(): NativeCompatibilityOwner | null { return owner; }
