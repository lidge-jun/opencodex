# Design debt

The changed-area APOSD audit found no open design debt for the Factory Droid integration.

- The export builder is isolated behind the existing client-config registry.
- Managed writes reuse the existing exact-fragment ownership and restore journal.
- Catalog refresh uses the shared owned-integration path.
- The loopback policy is enforced at the shared CLI export boundary.
