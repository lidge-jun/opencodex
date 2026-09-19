import type { CampaignStatus, PolicyDecisionKind, SecurityAuditEvent } from "./types";

export type SecurityHookName =
  | "onCampaignStatusChange"
  | "onPolicyDecision"
  | "onApprovalRequested"
  | "onBreakerTripped"
  | "onAudit";

export interface SecurityHookEvent {
  name: SecurityHookName;
  campaign_id?: string;
  from?: CampaignStatus;
  to?: CampaignStatus;
  decision?: PolicyDecisionKind;
  reason_code?: string;
  audit?: SecurityAuditEvent;
}

export type SecurityHookHandler = (event: SecurityHookEvent) => void | Promise<void>;

export class SecurityHookBus {
  private readonly handlers = new Map<SecurityHookName, Set<SecurityHookHandler>>();

  public on(name: SecurityHookName, handler: SecurityHookHandler): () => void {
    const set = this.handlers.get(name) ?? new Set();
    set.add(handler);
    this.handlers.set(name, set);
    return () => set.delete(handler);
  }

  public emit(event: SecurityHookEvent): void {
    const set = this.handlers.get(event.name);
    if (!set) return;
    for (const handler of set) {
      try {
        void Promise.resolve(handler(event)).catch(() => {
          /* hooks never reject into the control plane */
        });
      } catch {
        /* hooks never throw into the control plane */
      }
    }
  }
}
