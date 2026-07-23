import posthog from "posthog-js";

const DEFAULT_HOST = "https://eu.i.posthog.com";

function posthogKey(): string | undefined {
  const key = import.meta.env.VITE_POSTHOG_KEY;
  return typeof key === "string" && key.trim() ? key.trim() : undefined;
}

/** Init PostHog only when VITE_POSTHOG_KEY is set. No identify / no PII. */
export function initPostHog(): void {
  const key = posthogKey();
  if (!key || typeof window === "undefined") {
    return;
  }

  const host =
    typeof import.meta.env.VITE_POSTHOG_HOST === "string" &&
    import.meta.env.VITE_POSTHOG_HOST.trim()
      ? import.meta.env.VITE_POSTHOG_HOST.trim()
      : DEFAULT_HOST;

  posthog.init(key, {
    api_host: host,
    capture_pageview: false,
    capture_pageleave: true,
    persistence: "localStorage",
    person_profiles: "identified_only",
  });

  captureHashPageview();
  window.addEventListener("hashchange", captureHashPageview);
}

/** Manual $pageview for hash routes (e.g. #leveranciers). */
export function captureHashPageview(): void {
  if (!posthogKey() || !posthog.__loaded) {
    return;
  }

  posthog.capture("$pageview", {
    $current_url: window.location.href,
  });
}
