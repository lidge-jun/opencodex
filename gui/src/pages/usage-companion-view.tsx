import { useEffect, useState } from "react";
import { readJsonOrThrow } from "../fetch-json";
import type { ProvidersConfig } from "./providers-shared";
import UsageCompanionPanel from "./usage-companion-panel";

/** Provider names from the report are preferred; config covers an empty or unavailable report. */
export default function UsageCompanionView({ apiBase, providers }: {
  apiBase: string;
  providers: readonly { provider: string }[];
}) {
  const [configured, setConfigured] = useState<{ provider: string }[]>([]);
  useEffect(() => {
    if (providers.length > 0) return;
    const controller = new AbortController();
    fetch(`${apiBase}/api/config`, { signal: controller.signal })
      .then(response => readJsonOrThrow<Pick<ProvidersConfig, "providers">>(response))
      .then(config => {
        if (!controller.signal.aborted) setConfigured(Object.keys(config?.providers ?? {}).map(provider => ({ provider })));
      })
      .catch(() => {
        // Companion settings remain usable if config is temporarily unavailable.
      });
    return () => controller.abort();
  }, [apiBase, providers.length]);

  return <UsageCompanionPanel apiBase={apiBase} providers={providers.length > 0 ? providers : configured} />;
}
