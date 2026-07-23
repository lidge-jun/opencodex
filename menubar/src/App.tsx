import { useEffect } from "react";
import { StatusBar } from "./components/StatusBar";
import { StatsRow } from "./components/StatsRow";
import { ComboList } from "./components/ComboList";
import { QuotaBars } from "./components/QuotaBars";
import { QuickActions } from "./components/QuickActions";
import { useProxyClient } from "./hooks/useProxyClient";
import "./styles.css";

export default function App() {
  const client = useProxyClient();

  useEffect(() => {
    client.startPolling();
    return () => client.stopPolling();
  }, [client]);

  return (
    <div className="panel">
      <StatusBar
        online={client.online}
        version={client.version}
        uptime={client.uptime}
      />
      <div className="panel-body">
        <StatsRow
          requests={client.usage.requests}
          totalTokens={client.usage.totalTokens}
          estimatedCost={client.usage.estimatedCostUsd}
          stale={client.usageStale}
        />
        <ComboList
          combos={client.combos}
          onSwitch={client.switchCombo}
          stale={client.combosStale}
        />
        <QuotaBars
          reports={client.quotas}
          onRefresh={client.refreshQuotas}
          refreshing={client.quotaRefreshing}
          stale={client.quotasStale}
        />
      </div>
      <QuickActions onOpenDashboard={client.openDashboard} />
    </div>
  );
}
