# Container lifecycle mode

Amendment after real Docker recreation verification. Docker supervises the foreground hub and must retain persisted routed state across replacement.

MODIFY Dockerfile runtime ENV: set existing OCX_SERVICE=1, with no service manager installation or privilege change. Preserve image digest, foreground CMD, listener authentication, separate writable homes and read-only root.
MODIFY scripts/ci/docker-smoke.ts: assert the actual container process receives service lifecycle mode. Retain the routed synthetic slug and exact token/catalog/config hashes across graceful recreation.
MODIFY tests/service/container-bootstrap.test.ts: include the runtime ENV declaration in the existing packaging contract.
MODIFY docs-site/src/content/docs/guides/remote-hub.md: document service-mode foreground lifecycle, Compose restart/recreation, and the limit on other dashboard restart paths.

Independent Astra high lifecycle/security review accepted the bounded packaging change. Actual remote CLI comparison confirmed preservation with service mode. Final image CI must prove the same real container lifecycle; no local tests or Docker execution. This does not change shared CLI cleanup, restart policy, or authentication code.
