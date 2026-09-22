import { useEffect, useState } from "react";
import { navigateHash } from "../hash-routing";
import { modelsProviderHash, readModelsProvider, selectModelsTab } from "./models-tab";

/** Keep the selected provider in the Models URL across refresh and Back/Forward. */
export function useModelsProviderSelection() {
  const [selectedProvider, setSelectedProvider] = useState<string | null>(readModelsProvider);

  useEffect(() => {
    const syncFromHash = () => setSelectedProvider(readModelsProvider());
    window.addEventListener("hashchange", syncFromHash);
    window.addEventListener("popstate", syncFromHash);
    return () => {
      window.removeEventListener("hashchange", syncFromHash);
      window.removeEventListener("popstate", syncFromHash);
    };
  }, []);

  const selectProvider = (provider: string | null) => {
    setSelectedProvider(provider);
    if (provider === null) selectModelsTab("catalog");
    else navigateHash(modelsProviderHash(provider));
  };

  return { selectedProvider, setSelectedProvider, selectProvider };
}
