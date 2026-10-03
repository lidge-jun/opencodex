# wp1 revalidation

Previous D direction from 009: wp1 revalidates 010 against the latest integration base, then implements pure discovery and generated-document capacity. No change of direction is needed.

Current source baseline for wp1 is aa720907314ed2c5ca68f5c22d851148d66b1d0d, merging dev a141b83623a3f1677f23477e91b9a42a74f495f7 after the docs-only cycle. Incoming changes concern native upload bytes, Ollama commentary replay and test-layout cleanup. Comparing the audited 9f89b7265b baseline to this tree found no changes in src/cli, the skill generator/skill files, structure/runtime.md or structure/manifest.json. The exact 010 source/consumer design remains applicable.

The independent wp0 audit already corrected the explicit capabilities-command JSON projection owner. Current 010 includes that edit and a real serializer test; no helper-only proof is substituted. Optional usage leaves canonical invocation matching unchanged. The phase remains a pure metadata/documentation foundation with no management authority or runtime mutation change.

Current test-layout baseline was checked because the incoming integration commits changed both layout maps. New tests will be registered against these current maps rather than copied from the earlier baseline. The original structure owner is at its 600-line cap, so the mapped CLI contract move stays necessary.

The existing whole-unit architect proposal and concrete ALIGNED reflection cover CP-ARCH-02/04 and CP-SIZE-01 for 010. A bounded same-architect wp1 stale-check is requested; its resulting refinements and reflection will be recorded before A. Independent plan audit and actual B/C implementation proof are still required.

Same-architect wp1 proposal confirmed all relevant committed seams unchanged and supplied exact export/edge roles, isolated usage fixtures, closed chapter ownership/link preservation and minimal structure extraction. Main accepted these under existing CP-ARCH-02/04 and CP-SIZE-01 and appended them to 010; no new framework or authority was introduced. Current layout baseline: 18 pass, 0 fail, 555 assertions. Concrete refinement is returned to that same architect before independent wp1 A.

Same-architect reflection is ALIGNED for the concrete wp1 refinement (010 digest 11a4dd5ac83fe3578d580e9faea64f5882fb0f21092b12a7524cef1298511212). Artifact: `.tmp/cli-parity/wp1-reflection.md`. CP-ARCH-02, CP-ARCH-04 and CP-SIZE-01 have no essential mismatch; implementation and independent A/C proof remain separate.
