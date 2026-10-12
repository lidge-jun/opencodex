# ADR 0005: GUI uses role-based CSS design tokens

## Status

Accepted

## Context

The GUI accumulated thirteen font sizes, several near-duplicate weights, page-local radii, and
inline typography values. Those values made equivalent labels, controls, helper text, and machine
data render differently across pages and made dark/light maintenance harder.

The GUI must also remain usable when served locally or offline, including Korean locales. A remote
font or runtime styling dependency would add network and packaging failure modes to a management
surface that should remain available while the proxy is being repaired.

## Decision

Use native CSS custom properties in `gui/src/styles.css` as the runtime source of truth. Define:

- semantic light/dark color tokens;
- a Korean-safe UI font stack and a separate code/data font stack;
- eight role-based type sizes, four weights, and four line heights;
- a 4px-based spacing scale;
- shared radius, control height, icon size, and motion tokens;
- small typography utility classes for TSX contexts that previously used inline numeric values.

Keep component styling in the existing CSS and React primitives instead of adding CSS-in-JS,
Tailwind, a component framework, or a remote font. Document the contract under
`docs/design-system/` and require new visual values to use tokens.

For local integrated visual QA, use Vite's opt-in `OPENCODEX_PROXY_TARGET` proxy so the development
GUI can call the running management API through the same origin without changing production output.

## Alternatives considered

- **CSS-in-JS:** strong component co-location, but adds runtime and migration cost for no functional gain.
- **Utility framework:** broad ecosystem, but would duplicate the existing CSS and enlarge the change surface.
- **Remote or bundled web font:** stronger cross-platform identity, but remote loading harms offline reliability
  and bundling adds package size/licensing work. System Korean fallbacks are sufficient for this console.
- **Page-local cleanup only:** smaller initial diff, but leaves the inconsistency mechanism intact.

## Consequences

- Equivalent UI roles render consistently across all pages and locales.
- Dark/light changes can be made at the token layer.
- New contributors have a documented component and token contract.
- Existing layout-specific inline values remain allowed when they are algorithmic rather than visual roles.
- A future branded font can be introduced by changing `--font-ui` after packaging and licensing are decided.
