import { attachLinkTraffic, type LinkStatusDto } from "../../link/status-projection";
import { childLinkTraffic, createLinkTrafficBook } from "../../link/traffic";
import type { LinkRouteState } from "./link-route-state";

/**
 * `GET /api/link/status?traffic=1` (#3023). A Home reads its hub-link listener's book, a Child its
 * link transport's book (this process); a listener without one reads zeros counted from now.
 */
export function attachLinkTrafficForState(dto: LinkStatusDto, state: LinkRouteState): LinkStatusDto {
  const home = dto.role === "home";
  const empty = createLinkTrafficBook(home ? "content-length" : "relayed");
  return attachLinkTraffic(dto, linkId => home ? state.listener.linkTraffic?.(linkId) ?? empty.snapshot(linkId) : childLinkTraffic.snapshot(linkId));
}
