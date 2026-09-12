# ADR-0080 — decision recorded under "GitHub Pages"

- Contract owner: [ops/docs-and-release.md](../ops/docs-and-release.md#github-pages)

## Decision record

- 목적과 의도: Serve the public documentation from the memorable first-party `opencodex.me` domain.
- 기존 구현 및 제약 조건: The project Pages site was built for `lidge-jun.github.io/opencodex`, so Astro emitted a `/opencodex` base path that returns 404 under a root custom domain.
- 검토한 주요 대안: Keep the GitHub project URL as canonical; redirect the custom domain through Cloudflare; configure the custom domain directly on GitHub Pages and build for the domain root.
- 선택한 방식: Keep GitHub Actions Pages hosting, configure `opencodex.me` as the repository custom domain, publish root-relative assets and routes, and retain the default GitHub URL only as GitHub's automatic redirect.
- 다른 대안 대신 이 방식을 선택한 이유: Direct Pages hosting preserves the existing deployment and HTTPS lifecycle without adding a second proxy or redirect service.
- 장점, 단점 및 영향: Public links and canonical metadata become stable and branded. DNS and the Pages custom-domain setting are now deployment dependencies, and old hardcoded `/opencodex` links must not be reintroduced.
