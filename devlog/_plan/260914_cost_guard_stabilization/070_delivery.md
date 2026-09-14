# 070 — wp7: delivery

## Shape

wp2 and wp3 ship together as one pull request against `dev`: they are one policy —
hold a live binding for cache, release it only on real evidence — and splitting
them would land a default flip whose main remaining hole is still open. wp4, wp5
and wp6 follow as separate pull requests, each independently revertible.

## Verification

Local suite, typecheck, install and GUI build are not run, by explicit instruction.
The pull request states that plainly in its Verification section. The only proof is
hosted CI at the exact final head SHA; a green run against an earlier commit is not
evidence for the head that gets merged.

Pushes use `--no-verify`. Merges into `dev` are squash merges under the
single-maintainer dev integration policy in `MAINTAINERS.md`, with the merge
commit and the exact-head CI run recorded.

## Issue linkage

`Closes #4546` for the pull request carrying wp2 and wp3. Because pull requests
here target `dev` rather than the default branch, GitHub will not auto-close it;
the issue is closed by hand once the change is on `dev`, naming the merge commit.

## Documentation

The configuration reference and every locale translation change in the same pull
request as the behaviour, because a default documented in eight languages is wrong
in eight languages the moment the code lands. `structure/` ownership docs for the
affected invariants change with them.
