export interface StartOwnershipLease {
  release(): void;
}

export class StartOwnershipRollbackUncertainError extends AggregateError {
  constructor(errors: Iterable<unknown>) {
    super(errors, "start listener rollback could not be proven complete");
    this.name = "StartOwnershipRollbackUncertainError";
  }
}

export interface StartOwnershipPublicationDeps<TBound> {
  acquireLease(): StartOwnershipLease;
  bind(): Promise<TBound>;
  writePid(bound: TBound): void;
  writeRuntime(bound: TBound): void;
  stopBound(bound: TBound): void | Promise<void>;
  removeRuntime(): void;
  removePid(): void;
}

/** Bind and publish PID/runtime ownership as one lease-protected transaction. */
export async function bindAndPublishStartOwnership<TBound>(
  deps: StartOwnershipPublicationDeps<TBound>,
): Promise<TBound> {
  const lease = deps.acquireLease();
  let bound: TBound;
  let releaseLease = true;
  try {
    try { bound = await deps.bind(); }
    catch (error) {
      if (error instanceof StartOwnershipRollbackUncertainError) releaseLease = false;
      throw error;
    }
    try {
      deps.writePid(bound);
      deps.writeRuntime(bound);
    } catch (error) {
      const failures: unknown[] = [error];
      let stopFailed = false;
      try { await deps.stopBound(bound); }
      catch (failure) { stopFailed = true; failures.push(failure); }
      try { deps.removeRuntime(); } catch (failure) { failures.push(failure); }
      try { deps.removePid(); } catch (failure) { failures.push(failure); }
      if (stopFailed) {
        releaseLease = false;
        throw new StartOwnershipRollbackUncertainError(failures);
      }
      if (failures.length > 1) throw new AggregateError(failures, "start ownership publication rollback failed");
      throw error;
    }
    return bound;
  } finally {
    if (releaseLease) lease.release();
  }
}
