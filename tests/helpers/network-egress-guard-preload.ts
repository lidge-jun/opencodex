/** The egress guard as a Bun preload, for child processes that never run tests/preload.ts (#8848). */
import { installNetworkEgressGuard } from "./network-egress-guard";

installNetworkEgressGuard();
