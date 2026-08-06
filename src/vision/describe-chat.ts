import { createGoogleAdapter } from "../adapters/google";
import type { OcxParsedRequest, OcxProviderConfig } from "../types";
import { signalWithTimeout, cancelBodyOnAbort } from "../lib/abort";
import { redactSecretString } from "../lib/redact";
import { sidecarEnter } from "../lib/sidecar-tracker";
import { createTranslatorBudget } from "../lib/translator-budget";
import type { SidecarOutcomeRecorder } from "../web-search/executor";
import { getOAuthCredentialProjectId, getValidAccessToken } from "../oauth";

export interface ChatVisionSettings {
  model: string;
  timeoutMs: number;
  detail?: string;
  reasoning?: string;
}

export type DescribeChatOutcome = { text: string; error?: string };

function toChatImagePart(imageUrl: string, detail?: string): Record<string, unknown> {
  return { type: "image_url", image_url: { url: imageUrl, detail: detail ?? "high" } };
}

async function describeImageGoogle(
  imageUrl: string,
  detail: string | undefined,
  contextText: string,
  provider: OcxProviderConfig,
  providerName: string,
  settings: ChatVisionSettings,
  abortSignal?: AbortSignal,
  recordOutcome?: SidecarOutcomeRecorder,
): Promise<DescribeChatOutcome> {
  let requestProvider = provider;
  if (provider.authMode === "oauth") {
    try {
      const token = await getValidAccessToken(providerName);
      const project = provider.googleMode === "cloud-code-assist"
        ? getOAuthCredentialProjectId(providerName)
        : provider.project;
      requestProvider = { ...provider, apiKey: token, ...(project ? { project } : {}) };
    } catch (e) {
      return { text: "", error: `google oauth token failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  const parsed = {
    modelId: settings.model,
    context: {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: contextText || "Describe this image." },
          { type: "image", imageUrl, detail },
        ],
        timestamp: Date.now(),
      }],
    },
    stream: true,
    options: { maxOutputTokens: 1024, reasoning: "low" },
  } as OcxParsedRequest;
  const budget = createTranslatorBudget();
  const adapter = createGoogleAdapter(requestProvider);
  const sidecarExit = sidecarEnter("vision");
  try {
    const request = await adapter.buildRequest(parsed, {
      headers: new Headers(),
      translatorBudget: budget,
      abortSignal,
    });
    const response = adapter.fetchResponse
      ? await adapter.fetchResponse(request, {
        abortSignal,
        timeoutMs: settings.timeoutMs,
        stream: true,
        returnRawErrors: true,
      })
      : await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: abortSignal,
      });
    recordOutcome?.(response.status);
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return { text: "", error: `google sidecar HTTP ${response.status}: ${redactSecretString(text.slice(0, 200))}` };
    }
    let text = "";
    for await (const event of adapter.parseStream(response, budget)) {
      if (event.type === "text_delta") text += event.text;
      if (event.type === "error") return { text: "", error: event.message };
    }
    const trimmed = text.trim();
    if (!trimmed) return { text: "", error: "google sidecar produced no description" };
    return { text: trimmed };
  } catch (e) {
    recordOutcome?.(e instanceof Error && e.name === "TimeoutError" ? "timeout" : "connect_error");
    return { text: "", error: e instanceof Error ? e.message : String(e) };
  } finally {
    sidecarExit();
  }
}

export async function describeImageChat(
  imageUrl: string,
  detail: string | undefined,
  contextText: string,
  provider: OcxProviderConfig,
  providerName: string,
  settings: ChatVisionSettings,
  abortSignal?: AbortSignal,
  recordOutcome?: SidecarOutcomeRecorder,
): Promise<DescribeChatOutcome> {
  if (provider.adapter === "google") {
    return describeImageGoogle(
      imageUrl,
      detail,
      contextText,
      provider,
      providerName,
      settings,
      abortSignal,
      recordOutcome,
    );
  }
  let authHeader = "";
  if (provider.authMode === "oauth") {
    try {
      const token = await getValidAccessToken(providerName);
      authHeader = `Bearer ${token}`;
    } catch (e) {
      return { text: "", error: `oauth token failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  } else {
    const apiKey = provider.apiKey ?? provider.apiKeyPool?.[0]?.key ?? provider.headers?.Authorization?.replace(/^Bearer\s+/i, "");
    if (!apiKey) return { text: "", error: "provider has no API key or OAuth token" };
    authHeader = `Bearer ${apiKey}`;
  }

  const content: unknown[] = [
    { type: "text", text: contextText || "Describe this image." },
    toChatImagePart(imageUrl, detail),
  ];
  const body = {
    model: settings.model,
    messages: [{ role: "user", content }],
    stream: true,
    max_tokens: 1024,
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: authHeader,
    ...(provider.headers ?? {}),
  };

  const linkedSignal = signalWithTimeout(settings.timeoutMs ?? 30_000, abortSignal);
  const sidecarExit = sidecarEnter("vision");
  const t0 = Date.now();
  try {
    const baseUrl = provider.baseUrl.replace(/\/$/, "");
    const url = new URL(`${baseUrl}/chat/completions`);
    const res = await fetch(url.toString(), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: linkedSignal.signal,
    });
    recordOutcome?.(res.status);
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.warn(`[vision] chat sidecar HTTP ${res.status} (${Date.now() - t0}ms)`);
      return { text: "", error: `chat sidecar HTTP ${res.status}: ${redactSecretString(t.slice(0, 200))}` };
    }
    if (!res.body) return { text: "", error: "chat sidecar returned no response body" };
    const detachBodyGuard = cancelBodyOnAbort(res.body, linkedSignal.signal);
    let text = "";
    try {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const consumeLine = (line: string) => {
        const s = line.replace(/^data:\s*/, "").trim();
        if (!s || s === "[DONE]") return;
        try {
          const j = JSON.parse(s);
          const delta = j.choices?.[0]?.delta?.content;
          if (typeof delta === "string") text += delta;
          else if (Array.isArray(delta)) {
            for (const part of delta) if (typeof part?.text === "string") text += part.text;
          }
          const message = j.choices?.[0]?.message?.content;
          if (typeof message === "string") text += message;
        } catch { /* ignore non-JSON data lines */ }
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() ?? "";
        for (const line of lines) consumeLine(line);
      }
      consumeLine(buf);
      const trimmed = text.trim();
      if (!trimmed) return { text: "", error: "chat sidecar produced no description" };
      return { text: trimmed };
    } finally {
      detachBodyGuard();
    }
  } catch (e) {
    recordOutcome?.(e instanceof Error && e.name === "TimeoutError" ? "timeout" : "connect_error");
    console.warn(`[vision] chat sidecar error (${Date.now() - t0}ms)`);
    return { text: "", error: e instanceof Error ? e.message : String(e) };
  } finally {
    sidecarExit();
    linkedSignal.cleanup();
  }
}
