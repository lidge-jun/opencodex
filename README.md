# pr-assets

Screenshot and image evidence for opencodex pull requests lives on this branch, not on `dev`.

This branch shares no history with `dev`, `main` or `preview`. Nothing committed here can ride a
squash merge into the integration branch, and no CI workflow runs on pushes to it.

## When to use it

Most authors should drag the image into the pull request description editor instead. GitHub hosts
the attachment and no repository write is involved. Use this branch when you are a maintainer or an
agent with push access and need to upload from the command line.

## Layout

One directory per pull request or topic:

```text
<pr-number>/<short-name>.png        # once the PR number is known
<yymmdd>-<slug>/<short-name>.png    # before the PR exists
```

Keep images small (PNG or JPEG, a few hundred KB). Do not upload anything that contains credentials,
account identifiers, e-mail addresses, or private request bodies. `dev`'s privacy scan does not run here.

## Linking

Link by commit SHA, not by branch name, so the link keeps pointing at the same bytes:

```text
https://raw.githubusercontent.com/lidge-jun/opencodex/<commit-sha>/<pr-number>/<short-name>.png
```

## Rules

The "Protect pr-assets" ruleset blocks deletion and force-push, so every pinned SHA stays reachable.
Add files with ordinary commits. Replacing an image means committing a new file and linking the new SHA.

