# Regression and release follow-up

Status: OPEN / queued for the next PABCD cycle after the completed sixteen-issue implementation unit closes. This scope record preserves the active work; it is not a claim of regression, promotion or publication completion.

The owner explicitly authorized full hosted regression from request-time main134c92a01b120162f00c7275189cc47858720379 through the final integrated candidate, main/preview promotion and release publication. The implementation record is [archived separately](../../_fin/260919_contract_resolution/043_implementation_handoff.md). The overall goal and heartbeat remain active.

Current release candidate version is2.60.0; revalidate the frozen candidate, existing registry/tag state and branch ancestry before executing. The repository's release authority is scripts/release.ts and .github/workflows/release.yml. Publishing requires an immutable expected-sha, the release branch's successful push CI, applicable service-lifecycle proof, and dev already ahead of the intended release. The dev-version-bump workflow prepares that prerequisite through a pull request.

Remaining obligations: register the detailed next-cycle plan and acceptance criteria; freeze the candidate; run the full hosted regression lane including event-requested platform coverage; satisfy version ordering; promote through protected main/preview pull requests; run the canonical release workflow; verify the published version/tag/provenance and hosted package smoke. Record exact source, event, attempt and artifacts.

Local product tests, typecheck, builds, installs and runtime/service execution remain prohibited. Do not replace missing hosted evidence with a claimed pass. Do not stop the heartbeat or complete the host goal at the implementation handoff.
