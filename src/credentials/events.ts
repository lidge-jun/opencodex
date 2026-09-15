import type { CredentialEventName } from "./types";

export interface CredentialHookEvent {
  name: CredentialEventName;
  credential_id?: string | null;
  lease_id?: string | null;
  actor_id?: string | null;
  metadata?: Record<string, unknown>;
}

export class CredentialHookBus {
  private readonly listeners: Array<(event: CredentialHookEvent) => void> = [];

  public on(listener: (event: CredentialHookEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  public emit(event: CredentialHookEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* hooks never break the plane */ }
    }
  }
}

