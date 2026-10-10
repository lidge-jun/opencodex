# Container CI integration

Depends on the committed probe from phase 1.

## File delta

MODIFY `.github/workflows/ci.yml`: include Dockerfile, compose.yaml, .dockerignore and docker/** in relevant scope detection; add an ubuntu-latest Docker smoke job using the existing pinned checkout and setup-project-bun action; invoke the script after installing required project dependencies if the generator needs them. Preserve read-only workflow permissions and persist-credentials false. Add the job to aggregate ci needs so failures cannot silently pass. No registry publishing, credentials, native stack integration or changes to existing suite retry/concurrency policy.

MODIFY `tests/ci-workflows/ci-workflows.test.ts`: extend the existing source-oracle checks for scope paths, direct aggregate dependency, pinned actions, and actual probe invocation. Keep existing domain/layout registration unchanged by using the owning test file.

MODIFY `docs-site/src/content/docs/guides/remote-hub.md`: describe image lifecycle validation and separate readiness/provider-auth limitations.

## Acceptance and verifier

Final-branch Cross-platform CI workflow_dispatch must run the smoke and the existing platform gates. The Docker job's failures must reach ci. Local suite/typecheck NOT RUN per owner. Independent review checks full workflow event, permission, input, credential, and cleanup boundaries before publishing. Existing source-oracle tests execute remotely in CI.

Publish branches with --no-verify; do not claim lower-layer CI if only the final tree was tested. Final failure permits narrower runs. User authorized admin merge of verified layers; original author names/emails come from source commit metadata and are included as Co-authored-by trailers.

## Final execution inventory

Dispatch existing Cross-platform CI with lane=all on the immutable final head. Record each expected job and actual conclusion: Docker, four Linux shards, storage-policy, api-usage, gates, two macOS shards, macos-control, six Windows shards, keyring jobs, any selected npm packaging jobs, and ci. Aggregate green alone does not prove Windows or Docker ran. Explain legitimate scope skips instead of counting them as tests.
