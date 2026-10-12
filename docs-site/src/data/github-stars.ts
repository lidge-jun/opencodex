// Build-time GitHub star count for the repository links in the header and on
// the landing page. One unauthenticated request per build, shared by every
// page. Any failure (offline build, rate limit, timeout, unexpected payload)
// yields null and the UI renders the link without a number, so the build never
// depends on the network. OPENCODEX_DOCS_OFFLINE=1 skips the request entirely.
// No token is read on purpose: the count is public and the build must not
// handle credentials for it.

export const GITHUB_REPO = 'lidge-jun/opencodex';
export const GITHUB_URL = `https://github.com/${GITHUB_REPO}`;
export const GITHUB_API_URL = `https://api.github.com/repos/${GITHUB_REPO}`;

const TIMEOUT_MS = 5000;

let pending: Promise<number | null> | undefined;

/** Stargazer count, fetched once per build; null when unavailable. */
export function getStarCount(): Promise<number | null> {
	pending ??= load();
	return pending;
}

async function load(): Promise<number | null> {
	const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
	if (env?.OPENCODEX_DOCS_OFFLINE === '1') return null;
	try {
		const res = await fetch(GITHUB_API_URL, {
			headers: { accept: 'application/vnd.github+json', 'user-agent': 'opencodex-docs-build' },
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		if (!res.ok) return null;
		const data: unknown = await res.json();
		const count = (data as { stargazers_count?: unknown } | null)?.stargazers_count;
		return typeof count === 'number' && Number.isInteger(count) && count >= 0 ? count : null;
	} catch {
		return null;
	}
}

/**
 * Compact star label: 999, 1.2k, 23.4k, 123k, 1.2m. Rounds down so the label
 * never overstates the count. Labels remain static until the next build.
 */
export function formatStarCount(count: number): string {
	if (count < 1000) return String(count);
	if (count < 100_000) return `${trim(Math.floor(count / 100) / 10)}k`;
	if (count < 1_000_000) return `${Math.floor(count / 1000)}k`;
	return `${trim(Math.floor(count / 100_000) / 10)}m`;
}

const trim = (n: number) => String(n).replace(/\.0$/, '');
