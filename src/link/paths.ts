import { join } from "node:path";
// Definition-site import, not the ../config barrel: the link modules stay small and load nothing
// from the server or the config loader.
import { getConfigDir } from "../config/paths";

/** Directory that holds link state: `<configDir>/link`, created with mode 0700 on first write. */
export function linkDir(configDir: string = getConfigDir()): string {
  return join(configDir, "link");
}

/** Link records. Holds no secrets: data keys stay in the running proxy's `apiKeys`. */
export function linkStorePath(configDir?: string): string {
  return join(linkDir(configDir), "links.json");
}

/** The only known_hosts file link SSH commands trust. Entries are keyed by host alias. */
export function linkKnownHostsPath(configDir?: string): string {
  return join(linkDir(configDir), "known_hosts");
}
