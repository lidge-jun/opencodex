export interface LiveOutcome {
  status: number;
  requestId: string | null;
  selectedId: string;
  resolvedId: string;
}

export type LiveStatus = "AVAILABLE" | "NOT RUN (credential unavailable)" | "NOT RUN (live spend not authorized)" | "LIVE PASS" | "LIVE FAIL";

export function evaluateLivePolicy(hasKey: boolean, authorized: boolean, outcomes: LiveOutcome[]): {
  status: LiveStatus;
  liveCalls: 0 | 2;
  failed: boolean;
} {
  if (!hasKey) return { status: "NOT RUN (credential unavailable)", liveCalls: 0, failed: false };
  if (!authorized) return { status: "NOT RUN (live spend not authorized)", liveCalls: 0, failed: false };
  const exact = outcomes.length === 2
    && outcomes[0]?.status >= 200 && outcomes[0].status < 300
    && outcomes[0].selectedId === "openai-apikey/gpt-5.6-sol"
    && outcomes[0].resolvedId === "gpt-5.6-sol"
    && outcomes[1]?.status >= 200 && outcomes[1].status < 300
    && outcomes[1].selectedId === "openai-apikey/gpt-5.6-sol-pro"
    && outcomes[1].resolvedId === "gpt-5.6-sol";
  return { status: exact ? "LIVE PASS" : "LIVE FAIL", liveCalls: 2, failed: !exact };
}
