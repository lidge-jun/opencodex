# Design QA — OpenCodex Remote

result: blocked

## Sources

- `platform/docs/assets/instances-reference.png` — approved Instances screen, 1488×1058.
- `platform/docs/assets/agent-onboarding-reference.png` — approved Agent onboarding, 1488×1058.
- Implementation: `platform/web/src/App.tsx`, `platform/web/src/styles.css`.

## Completed checks

- Both approved source images were opened at original resolution before implementation.
- Existing OpenCodex logo and dark design tokens were reused.
- Visible UI icons come from `@tabler/icons-react`; no custom SVG or placeholder illustration was added.
- Desktop and responsive CSS states, loading/error/empty/login/invite states, primary actions, form flow, copy actions, and destructive confirmations are implemented.
- TypeScript and production build passed after the final auth/invite handoff edits.

## Blocker

The environment had no browser tool and no previously selected browser. The Product Design workflow requires permission before using Playwright directly. Permission was requested, but the task changed to a branch handoff before a response was received. Therefore no same-viewport implementation screenshot exists and the mandatory side-by-side source/implementation comparison cannot honestly be marked passed.

## Required next pass

1. Start `VITE_REMOTE_DEMO=true bun run dev:web` in `platform/`.
2. With the user's selected browser or approved Playwright Chromium, capture 1488×1058 Instances.
3. Click New instance, reserve the demo instance, and capture 1488×1058 Install Agent.
4. Put each reference and matching implementation capture into one side-by-side image.
5. Review typography, grid, spacing, colors, icon alignment, borders, states, keyboard/focus, tablet, and mobile.
6. Fix all P0/P1/P2 findings and change only the final line below when the comparison genuinely passes.

Final result: blocked
