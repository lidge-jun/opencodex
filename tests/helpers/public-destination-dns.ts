import { spyOn } from "bun:test";
import * as dnsPromises from "node:dns/promises";

export function stubPublicDestinationDnsFor(...hostnames: string[]) {
  const deterministicHosts = new Set(hostnames);
  const originalLookup = dnsPromises.lookup;
  return spyOn(dnsPromises, "lookup").mockImplementation(((hostname: string, options?: unknown) => {
    if (deterministicHosts.has(hostname) && options && typeof options === "object"
      && "all" in options && options.all === true) {
      return Promise.resolve([{ address: "8.8.8.8", family: 4 }]);
    }
    return originalLookup(hostname, options as never);
  }) as typeof dnsPromises.lookup);
}
