# Windows unreadable-config shim fixture deadline

Final run 34057173038 passed 23 individual jobs and failed only Windows shard 2 (plus aggregate). The original shim unreadable-config test had a 10-second outer timeout and no owned child deadline. Bun killed the dangling child at 10.24 seconds, yielding status null. Fixture and inspected runtime source were unchanged since 8615f1a. The specific slow runtime stage is unproven; this is not an environmental or cache-causation claim.

MODIFY only that subprocess fixture: use the existing 45-second spawn budget on Windows and a named 5-second outer cleanup allowance. Preserve POSIX's 10-second limit, all temporary paths, fake launcher, real install/diagnosis/advisory path and original exit/output assertions. Error/signal diagnostics are fixed and omit captured output. Product behavior is unchanged.

Remote diagnostic https://github.com/lidge-jun/opencodex/actions/runs/34058337624 pinned c7a96b14f and demonstrated:

- Unchanged control: real CLI exit 0 and original assertions pass.
- With a 12-second preload delay, old limit: child is signalled and test times out.
- Same delayed CLI with owned Windows deadline: exit 0 and original assertions pass.
- Same new limit with the readiness collector's advisory catch changed to rethrow: real CLI exits 1 without timeout/signal; the original exit-0 assertion fails.

The diagnostic restored source bytes and is excluded from delivery. Its initial run 34058187661 failed before tests because Python selected a Windows legacy codec; explicit UTF-8 corrected that diagnostic-only error. No passing rerun was used to erase a product failure. Source/security review of the diagnostic and independent source review of the candidate passed. No local suites, installs, typecheck or builds were run. Final cross-platform CI remains required for the published combined head.
