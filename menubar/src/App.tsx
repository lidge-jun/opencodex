import { useState } from "react";
import { useEffect } from "react";
import { initProxyConfig } from "./api";
import Usage from "./sections/Usage";
import Health from "./sections/Health";
import Status from "./sections/Status";
import Activity from "./sections/Activity";

type Section = "usage" | "health" | "status" | "activity";

const TABS: { id: Section; label: string }[] = [
  { id: "usage", label: "Usage" },
  { id: "health", label: "Health" },
  { id: "status", label: "Status" },
  { id: "activity", label: "Activity" },
];

export default function App() {
  const [active, setActive] = useState<Section>("usage");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    initProxyConfig()
      .then(() => setReady(true))
      .catch(() => setReady(true)); // show UI even if discovery fails
  }, []);

  return (
    <div className="popover">
      <header className="popover-header">
        <h1>OpenCodex</h1>
        <nav className="section-tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={t.id === active ? "tab active" : "tab"}
              onClick={() => setActive(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>
      <main className="popover-body">
        {!ready ? (
          <div className="section-loading">Connecting to proxy…</div>
        ) : (
          <>
            {active === "usage" && <Usage />}
            {active === "health" && <Health />}
            {active === "status" && <Status />}
            {active === "activity" && <Activity />}
          </>
        )}
      </main>
    </div>
  );
}
