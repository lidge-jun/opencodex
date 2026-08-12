import type { OwnershipInspection } from "../../src/integrations/native/ownership-preflight";

/**
 * Service-home ownership evidence for tests that sandbox CODEX_HOME /
 * OPENCODEX_HOME but start a server in THIS process.
 *
 * `claimOwnedServiceHome` in ./owned-service-home.ts is the other half of this
 * problem and stays the right tool when a fixture can seed real state and a
 * service-manager definition — notably for a spawned child that gets its own
 * HOME and PATH. It cannot help an in-process `startServer`, which reads the
 * host's real launchd/systemd registration through `inspectNativeCodexOwnership`
 * before it touches any Codex lock, cache, owner, journal, or credential path.
 *
 * On a machine running ocx as a service, that inspection sees a loaded job whose
 * definition names the developer's real homes, returns `ownership: "unknown"`
 * for the fixture's temp homes, and fences native-main admission closed — so the
 * startup gate never opens and the assertions time out.
 *
 * The failure is invisible in CI (no runner has ocx installed as a service) and
 * reproducible on exactly the maintainer machines that run the proxy they are
 * developing, including through the local preflight suite in scripts/release.ts.
 *
 * A test that wants to exercise the FENCED path must assert on the real
 * inspection instead of using this seam.
 */
export function ownedServiceHomeInspection(reason: string): () => OwnershipInspection {
  return () => ({ ownership: "owned", reason });
}
