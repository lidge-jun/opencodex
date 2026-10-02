import { useState } from "react";
import { useT } from "../i18n/shared";
import { interceptReasonKey } from "../pages/claude-code-first-party";

const FAILED_REASON = "failed";

export default function ClaudeInterceptStart({ apiBase, reason, port, onStarted }: {
  apiBase: string; reason?: string | null; port?: number; onStarted: () => void;
}) {
  const t = useT();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<{ reason: string; port?: number } | null>(null);
  const start = async () => {
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const response = await fetch(`${apiBase}/api/claude-intercept/start`, { method: "POST" });
      const result = await response.json() as { ok?: boolean; reason?: string; port?: number };
      if (!response.ok || !result.ok) setFailure({ reason: result.reason ?? FAILED_REASON, port: result.port });
      else onStarted();
    } catch { setFailure({ reason: FAILED_REASON }); }
    finally { setPending(false); }
  };
  return <span role="status">
    {t(interceptReasonKey(failure?.reason ?? reason), { port: failure?.port ?? port ?? "" })}{" "}
    <button type="button" className="btn btn-ghost" disabled={pending} onClick={() => void start()}>
      {t(pending ? "claude.intercept.starting" : "claude.intercept.start")}
    </button>
  </span>;
}
