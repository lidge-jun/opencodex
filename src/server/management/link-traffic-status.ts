import { attachLinkTraffic, type LinkStatusDto } from "../../link/status-projection";
import { childLinkTraffic, createLinkTrafficBook } from "../../link/traffic";
import { createLinkPathResolver } from "../../link/ssh-route";
import type { SshRunner } from "../../link/ssh-runner";
import type { LinkRouteState } from "./link-route-state";

/**
 * `GET /api/link/status?traffic=1` (#3023). A Home reads its hub-link listener's book, a Child its
 * relay's book (this process); a listener without one reads zeros counted from now. Path
 * resolution is cached on the route state, so repeated reads spawn no new `ssh -G` inside its TTL.
 */
export async function attachLinkTrafficForState(dto: LinkStatusDto, state: LinkRouteState, runner: () => SshRunner): Promise<LinkStatusDto> {
  state.pathResolver ??= createLinkPathResolver({ runner });
  const resolver = state.pathResolver;
  const home = dto.role === "home";
  const empty = createLinkTrafficBook(home ? "content-length" : "relayed");
  return attachLinkTraffic(dto, {
    traffic: linkId => home ? state.listener.linkTraffic?.(linkId) ?? empty.snapshot(linkId) : childLinkTraffic.snapshot(linkId),
    resolvePath: alias => resolver.resolve(alias),
  });
}
