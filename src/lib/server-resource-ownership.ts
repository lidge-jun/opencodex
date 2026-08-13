type Cleanup = () => void;

type ServerResourceOwner = {
  token: symbol;
  cleanups: Set<Cleanup>;
};

export type ServerResourceOwnerLease = {
  release(): void;
};

const owners: ServerResourceOwner[] = [];

function currentOwner(): ServerResourceOwner | undefined {
  return owners.at(-1);
}

/** Acquire ownership for resources created while one server instance starts. */
export function acquireServerResourceOwner(): ServerResourceOwnerLease {
  const owner: ServerResourceOwner = {
    token: Symbol("server-resource-owner"),
    cleanups: new Set(),
  };
  owners.push(owner);

  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      const index = owners.findIndex(candidate => candidate.token === owner.token);
      if (index !== -1) owners.splice(index, 1);
      for (const cleanup of [...owner.cleanups]) {
        try {
          cleanup();
        } catch {
          // Resource cleanup is best-effort and one failed hook must not retain siblings.
        }
      }
      owner.cleanups.clear();
    },
  };
}

/** Attach cleanup to the server instance currently being started. */
export function registerCurrentServerResourceCleanup(cleanup: Cleanup): () => void {
  const owner = currentOwner();
  if (!owner) return () => {};
  owner.cleanups.add(cleanup);
  let attached = true;
  return () => {
    if (!attached) return;
    attached = false;
    owner.cleanups.delete(cleanup);
  };
}

/** Test-only reset for isolated lifecycle tests. */
export function resetServerResourceOwnershipForTests(): void {
  for (const owner of [...owners].reverse()) {
    for (const cleanup of [...owner.cleanups]) {
      try {
        cleanup();
      } catch {
        // Test reset must leave no retained owner even when a synthetic cleanup throws.
      }
    }
    owner.cleanups.clear();
  }
  owners.length = 0;
}
