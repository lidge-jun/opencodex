# 060 — Close-out: supersede operations and attribution

Work-phase: wp7. No code. GitHub state only.

## Ordering rule

A PR is closed ONLY after its replacement exists and is pushed. Never close first.

## Operations

| Close | Author | Replaced by | Carried over |
|---|---|---|---|
| #2131 | @bet4it | layer 2 (020) | full implementation + tests, plus unique-id correction |
| #2099 | @yzxcj797 | sibling A (030) | issue link, repro fixture |
| #2091 | @luvs01 | sibling A (030) | nothing; contract deliberately narrower |
| #2100 | @ntdatt812 | sibling B (040) | full implementation + tests |
| #2077 | @ntdatt812 | sibling B (040) | full implementation + tests |
| #2102 | @lilinxiong | sibling A (030) | full implementation + tests (base) |
| #2062 | @yzxcj797 | sibling C (050) | nothing; #2056 supersedes |
| #2063 | @yzxcj797 | merged #2055 | nothing |
| #2056 | @Ingwannu | sibling C (050) | full implementation + scorer correction |
| #2029 | @yzxcj797 | maintainer PR #2130 | nothing; #2130 is a superset |

## Comment template

> Thanks for this, @<login> — closing as superseded by #<n>, which carries <what> from your
> patch. <What changed and why.> Your work is credited in that PR's description.

## NOT closed, with reasons stated publicly

- **#2109 / #2110** (@drakonkat): unresolved security gap in the override gate; needs a human
  security pass (AGENTS.md security boundary).
- **#2053** (@Ingwannu): C4 OAuth surface; MAINTAINERS.md mandates security review.
- **#2101, #2040**: large (20 and 14 files); each needs its own PABCD cycle.
- **#2115, #2082, #2027, #2067, #2054, #2032**: below the 60 threshold.
- **#2104, #2075, #2127**: #2075/#2054 CONFLICTING; #2127 is an active draft by its author.

