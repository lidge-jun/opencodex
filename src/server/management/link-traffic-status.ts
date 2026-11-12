import { attachLinkTraffic, type LinkStatusDto } from "../../link/status-projection";
import { childLinkTraffic, createLinkTrafficBook } from "../../link/traffic";
import { resolveLinkPathFromConfig, type LinkPathConfigDeps } from "../../link/ssh-route";
import type { LinkRouteState } from "./link-route-state";

/**
 * `GET /api/link/status?traffic=1` (#3023). A Home reads its hub-link listener's book, a Child its
 * relay's book (this process); a listener without one reads zeros counted from now. A path comes
 * from the ssh_config files (`resolveLinkPathFromConfig`): no process is started for a status read.
 */
export async function attachLinkTrafficForState(dto: LinkStatusDto, state: LinkRouteState, pathConfig: LinkPathConfigDeps = {}): Promise<LinkStatusDto> {
  const home = dto.role === "home";
  const empty = createLinkTrafficBook(home ? "content-length" : "relayed");
  return attachLinkTraffic(dto, {
    traffic: linkId => home ? state.listener.linkTraffic?.(linkId) ?? empty.snapshot(linkId) : childLinkTraffic.snapshot(linkId),
    resolvePath: async alias => ({ via: resolveLinkPathFromConfig(alias, pathConfig) }),
  });
}
