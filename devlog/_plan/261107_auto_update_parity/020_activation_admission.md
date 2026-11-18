# Automatic activation admission — draft unit

**Status:** open. No automatic activation or admission guarantee is implemented
by this plan. Architecture, platform behavior and independent security review
must be completed before implementation.

## Planned outcome

Automatic activation would proceed only when the responsible runtime and
installation owner can establish that work is idle and the selected update is
still eligible. Busy, unavailable or uncertain state must defer activation.
An operator's ordinary shutdown behavior remains a separate contract.

## Evidence required before delivery

- Define and independently review the ownership and coordination contract for
  each supported runtime, installation owner and linked-machine direction.
- Demonstrate safe deferral, cancellation, restart and recovery with isolated
  test homes and controlled concurrent work; include process interruption and
  every supported platform.
- Preserve the core/Compatibility Lab boundary and update the relevant
  `structure/` owners only when the behavior actually ships.
- Run focused failing-first regression tests, test-layout and file-size guards,
  typecheck, privacy and structure checks, and exact-head CI before delivery.

Security working analysis and implementation details are kept outside the
tracked roadmap until the corresponding work is public.
