# ADR-0081 — decision recorded under "Container deployment recipe"

- Contract owner: [ops/docs-and-release.md](../ops/docs-and-release.md#container-deployment-recipe)

## Decision record

- 목적과 의도: Document a reproducible container topology without silently creating an official image channel.
- 기존 구현 및 제약 조건: The documentation recipe was not executable from the repository root, file-backed Compose secret ownership varies by implementation, and no registry workflow, scanner, SBOM/signing chain, or image rollback policy exists.
- 검토한 주요 대안: Publish an official image; keep only copied documentation snippets; ship a maintained source recipe with a volume-backed stdin bootstrap.
- 선택한 방식: Maintain the root source-build recipe, persist the owner-only token in the state volume, publish only `10100`, and leave registry publication out of scope.
- 다른 대안 대신 이 방식을 선택한 이유: A runnable source recipe can be tested and reviewed without claiming provenance and operational controls the project does not provide.
- 장점, 단점 및 영향: Compose users get a reproducible non-root deployment and safe first-run secret path; operators still own image builds, upgrades, external TLS/tailnet management, and rollout policy.
