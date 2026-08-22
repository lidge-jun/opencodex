export interface SseLineBoundaryState {
  atBoundary: boolean;
  pendingCr: boolean;
}

export function createSseLineBoundaryState(): SseLineBoundaryState {
  return { atBoundary: true, pendingCr: false };
}

export function canInjectSseHeartbeat(state: SseLineBoundaryState): boolean {
  return state.atBoundary && !state.pendingCr;
}

export function updateSseLineBoundaryState(
  state: SseLineBoundaryState,
  chunk: Uint8Array,
): SseLineBoundaryState {
  let atBoundary = state.atBoundary;
  let pendingCr = state.pendingCr;

  for (let i = 0; i < chunk.length; i += 1) {
    if (pendingCr) {
      pendingCr = false;
      if (chunk[i] === 0x0a) {
        atBoundary = true;
        continue;
      }
      atBoundary = false;
    }

    const byte = chunk[i]!;
    if (byte === 0x0a) {
      atBoundary = true;
      continue;
    }
    if (byte === 0x0d) {
      if (i + 1 < chunk.length && chunk[i + 1] === 0x0a) {
        atBoundary = true;
        i += 1;
      } else if (i + 1 >= chunk.length) {
        pendingCr = true;
        atBoundary = true;
      } else {
        atBoundary = true;
      }
      continue;
    }
    atBoundary = false;
  }

  return { atBoundary, pendingCr };
}

/** @deprecated Use createSseLineBoundaryState and updateSseLineBoundaryState. */
export function isAtSseLineBoundary(chunk: Uint8Array): boolean {
  return canInjectSseHeartbeat(updateSseLineBoundaryState(createSseLineBoundaryState(), chunk));
}

/** @deprecated Use updateSseLineBoundaryState. */
export function updateSseLineBoundary(atBoundary: boolean, chunk: Uint8Array): boolean {
  return updateSseLineBoundaryState({ atBoundary, pendingCr: false }, chunk).atBoundary;
}
