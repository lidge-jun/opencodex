# Cursor / WSL / systemd Rollup Plan

Date: 2026-07-05
Mode: three PABCD work-phases in one plan folder
Archetype: spec-satisfaction repair

## Goal

Ship one coherent local change set covering:

- #62 Cursor live native local execution hardening.
- #63 WSL Codex Desktop home resolution.
- Ubuntu `ocx service start` failure when the systemd user unit is missing.

## Non-goals

- No service manager replacement.
- No broad service lifecycle rewrite.
- No change to direct `ocx start`.
- No rollback of existing #62 or #63 uncommitted changes.

## Work-Phase Map

1. Cycle 1: create this devlog folder and record the combined scope.
2. Cycle 2: patch Ubuntu systemd start diagnostics and regression coverage.
3. Cycle 3: record final verification evidence for the whole change set.

## Acceptance

- `ocx service start` should not surface a raw `systemctl --user start opencodex-proxy` unit-not-found stack when the service was never installed.
- The user-facing fix should explain that `ocx service install` creates the systemd user unit.
- Existing #62 and #63 tests remain green.
- Full relevant checks pass before completion.

