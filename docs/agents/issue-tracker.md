# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues on the **fork** `genglintong/opencodex`. Use the `gh` CLI with `--repo genglintong/opencodex` for all operations.

## Conventions

- **Create an issue**: `gh issue create --repo genglintong/opencodex --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --repo genglintong/opencodex --comments`
- **List issues**: `gh issue list --repo genglintong/opencodex --state open --json number,title,body,labels,comments`
- **Comment on an issue**: `gh issue comment <number> --repo genglintong/opencodex --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --repo genglintong/opencodex --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --repo genglintong/opencodex --comment "..."`

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: issue #1 labelled `wayfinder:map` on `genglintong/opencodex`.
- **Child ticket**: issues linked via task list in the map body, with `Parent map: #1` in child body. Labels: `wayfinder:<type>`.
- **Blocking**: `Blocked by: #<n>` line in child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list open children, drop any with an open blocker or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --repo genglintong/opencodex --add-assignee @me`
- **Resolve**: `gh issue comment <n> --repo genglintong/opencodex --body "<answer>"`, then `gh issue close <n>`, then append a context pointer to the map's Decisions-so-far.
