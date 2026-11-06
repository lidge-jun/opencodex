import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { LaptopIcon } from "@hugeicons/core-free-icons";
import type { Locale, TFn } from "../../i18n/shared";
import { IconCheck, IconGlobe, IconKey, IconMonitor } from "../../icons";
import { Select } from "../../ui";
import { cn } from "../../lib/utils";
import { hostOs } from "../../lib/desktop-shell";
import { USAGE_SOURCE_INVENTORY_CHANGED, sourceInventoryEventMatches } from "../../api";
import { matchesFacetWindow, matchesSource, noStore, sourceQuery, SOURCE_CLIENTS, type SourceClient, type SourceDevice, type SourceFilter } from "./usage-source";

type Facets = { sourceFilter: unknown; window: { since: number; until: number; timeZone: string }; apps: Record<SourceClient, number>;
  devices: { device: SourceDevice; requests: number }[]; legacyUnclassifiedRequests: number; usageIncomplete: boolean };
type Inventory = { apiKeyId: string; alias: string | null }[];
const clientNames: Record<SourceClient, string> = { all: "", codex: "Codex", claude_code: "Claude Code", claude_desktop: "Claude Desktop", grok: "Grok", opencode: "OpenCode", aside: "Aside", other: "", unknown: "" };
const sameDevice = (a: SourceDevice, b: SourceDevice) => a.kind === b.kind && (a.kind !== "key" || (b.kind === "key" && a.id === b.id));
const validCount = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
function validFacets(value: Facets, filter: SourceFilter): boolean {
  if (!value || !matchesSource(value.sourceFilter, filter) || !value.window || !Number.isFinite(value.window.since)
    || !matchesFacetWindow(value.window) || typeof value.usageIncomplete !== "boolean" || !value.apps
    || !SOURCE_CLIENTS.every(client => validCount(value.apps[client])) || !validCount(value.legacyUnclassifiedRequests)
    || !Array.isArray(value.devices)) return false;
  return value.devices.every(row => row && validCount(row.requests) && row.device &&
    (["all", "no-key", "unconfigured"].includes(row.device.kind) || (row.device.kind === "key" && typeof row.device.id === "string" && !!row.device.id)));
}

export function UsageSourcePicker({ apiBase, filter, onClient, onDevice, deviceLocked, facetsAllowed, homeScope, t, locale }: {
  apiBase: string; filter: SourceFilter | null; onClient: (client: SourceClient) => void; onDevice: (device: SourceDevice) => void;
  deviceLocked: boolean; facetsAllowed: boolean; homeScope: boolean; t: TFn; locale: Locale;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [result, setResult] = useState<{ key: string; facets?: Facets; inventory?: Inventory; failed?: boolean }>({ key: "" });
  const [knownInventory, setKnownInventory] = useState<{ apiBase: string; items: Inventory }>({ apiBase: "", items: [] });
  const input = useRef<HTMLInputElement>(null);
  const filterKey = JSON.stringify(filter);
  const clientLabel = (client: SourceClient) => clientNames[client] || t(client === "all" ? "usageV2.allApps" : client === "other" ? "usageV2.otherApps" : "usageV2.unknown");
  const data = result.key === filterKey ? result : { key: filterKey };
  const deviceLabel = (device: SourceDevice) => {
    if (device.kind === "all") return t("usageV2.allDevices");
    if (device.kind === "no-key") return t(homeScope ? "usageV2.homeDevice" : hostOs() === "macos" ? "usageV2.thisMac" : "usageV2.thisDevice");
    if (device.kind === "unconfigured") return t("usageV2.unconfigured");
    if (device.kind === "key") {
      const inventory = data.inventory ?? (knownInventory.apiBase === apiBase ? knownInventory.items : []);
      const inventoryIndex = inventory.findIndex(item => item.apiKeyId === device.id);
      const entry = inventory[inventoryIndex];
      const facetIndex = data.facets?.devices.filter(row => row.device.kind === "key").findIndex(row => sameDevice(row.device, device)) ?? -1;
      const number = Math.max(1, (entry ? inventoryIndex : facetIndex) + 1);
      if (entry?.alias) return entry.alias;
      return t(entry ? "usageV2.unknownLinkedDevice" : "usageV2.unknownDeviceNumber", { number });
    }
    return t("usageV2.unknown");
  };
  useEffect(() => {
    const requested = JSON.parse(filterKey) as SourceFilter | null;
    if (!open || !requested || !facetsAllowed) return;
    let disposed = false;
    let sequence = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    const load = async () => {
      const id = ++sequence;
      controller?.abort(); controller = new AbortController();
      setResult({ key: filterKey });
      try {
        const [response, inventoryResponse] = await Promise.all([
          fetch(`${apiBase}/api/usage/source-facets?${sourceQuery(requested)}`, { signal: controller.signal, cache: "no-store" }),
          fetch(`${apiBase}/api/usage/devices`, { signal: controller.signal, cache: "no-store" }),
        ]);
        if (!response.ok || !noStore(response)) throw new Error("facets unavailable");
        const facets = await response.json() as Facets;
        if (!validFacets(facets, requested)) throw new Error("invalid facets");
        let inventory: Inventory = [];
        if (inventoryResponse.ok) {
          const body: unknown = await inventoryResponse.json();
          if (body && typeof body === "object" && Array.isArray((body as { devices?: unknown }).devices)) {
            inventory = (body as { devices: Inventory }).devices.filter(item => item && typeof item.apiKeyId === "string" && (typeof item.alias === "string" || item.alias === null));
          }
        }
        if (!disposed && id === sequence) { setKnownInventory({ apiBase, items: inventory }); setResult({ key: filterKey, facets, inventory }); }
      } catch {
        if (!disposed && id === sequence) setResult({ key: filterKey, failed: true });
      } finally {
        if (!disposed && id === sequence) timer = setTimeout(load, 15_000);
      }
    };
    void load();
    const focus = () => { if (timer) clearTimeout(timer); void load(); };
    const inventoryChanged = (event: Event) => { if (sourceInventoryEventMatches(event, apiBase)) focus(); };
    window.addEventListener("focus", focus);
    window.addEventListener(USAGE_SOURCE_INVENTORY_CHANGED, inventoryChanged);
    return () => { disposed = true; sequence++; controller?.abort(); if (timer) clearTimeout(timer); window.removeEventListener("focus", focus); window.removeEventListener(USAGE_SOURCE_INVENTORY_CHANGED, inventoryChanged); };
  }, [open, apiBase, facetsAllowed, filterKey]);
  useEffect(() => {
    const clear = () => setKnownInventory({ apiBase: "", items: [] });
    const changed = (event: Event) => { if (sourceInventoryEventMatches(event, apiBase)) clear(); };
    window.addEventListener("focus", clear);
    window.addEventListener(USAGE_SOURCE_INVENTORY_CHANGED, changed);
    return () => { window.removeEventListener("focus", clear); window.removeEventListener(USAGE_SOURCE_INVENTORY_CHANGED, changed); };
  }, [apiBase]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
    const active = event.target as HTMLButtonElement;
    if (active.getAttribute("role") !== "radio") return;
    const group = active.closest('[role="radiogroup"]');
    const radios = [...(group?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])];
    const index = radios.indexOf(active);
    if (index < 0 || !radios.length) return;
    event.preventDefault();
    const next = radios[(index + (event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1) + radios.length) % radios.length];
    next?.focus(); next?.click();
  };
  const markFor = (client: SourceClient) => ({ codex: "openai.svg", claude_code: "claude-color.svg", claude_desktop: "claude-color.svg", grok: "grok.svg", opencode: "opencode.svg", aside: "aside.svg" } as Partial<Record<SourceClient, string>>)[client];
  const appMark = (client: SourceClient) => {
    const mark = markFor(client);
    return mark ? <img className={`usage-source-mark${client === "grok" ? " usage-source-mark--mono" : ""}`} src={`/provider-icons/${mark}`} alt="" /> : <IconGlobe width={16} height={16} aria-hidden="true" />;
  };
  const appDetail = (client: SourceClient) => client === "codex"
    ? [t("usageV2.codexDetail"), data.facets && !data.facets.usageIncomplete
      ? t("usageV2.codexUnclassified", { count: data.facets.legacyUnclassifiedRequests.toLocaleString(locale) }) : null].filter(Boolean).join(" · ")
    : client === "other" ? t("usageV2.otherDetail") : "";
  const q = search.trim().toLocaleLowerCase(locale);
  const visible = (text: string) => !q || text.toLocaleLowerCase(locale).includes(q);
  const count = (value: number | undefined) => data.facets && !data.facets.usageIncomplete && value !== undefined ? value.toLocaleString(locale) : "—";
  const devices: SourceDevice[] = deviceLocked ? (filter ? [filter.device] : []) : data.facets?.devices.map(row => row.device) ?? [{ kind: "all" }, { kind: "no-key" }, { kind: "unconfigured" }];
  const visibleClients = SOURCE_CLIENTS.filter(client => visible(`${clientLabel(client)} ${appDetail(client)}`));
  const visibleDevices = devices.filter(device => visible(deviceLabel(device)));
  return <Select.Popup open={open} onOpenChange={next => { setOpen(next); if (!next) setResult({ key: "" }); else setSearch(""); }}
    label={t("usageV2.source")} initialFocusRef={input} maxHeight={700} className="ui-v2 overflow-auto rounded-panel bg-raised p-3 text-[13px] text-fg shadow-lg ring-1 ring-line" onKeyDown={onKeyDown}
    trigger={<>{appMark(filter?.client ?? "codex")}<span>{clientLabel(filter?.client ?? "codex")}</span><span aria-hidden="true">·</span><span>{filter ? deviceLabel(filter.device) : t("usageV2.unknown")}</span></>}>
      <input ref={input} className="input w-full" type="search" aria-label={t("usageV2.searchSources")} placeholder={t("usageV2.searchSources")} value={search} onChange={event => setSearch(event.currentTarget.value)} />
      <div role="radiogroup" aria-label={t("usageV2.apps")} className="mt-3">
        <div className="flex justify-between px-2 text-fg-muted"><span>{t("usageV2.apps")}</span><span>{t("usageV2.last30")}</span></div>
        {visibleClients.map(client => {
          const selected = filter?.client === client;
          return <button key={client} type="button" role="radio" aria-checked={selected} tabIndex={selected || (!visibleClients.includes(filter?.client ?? "codex") && visibleClients[0] === client) ? 0 : -1} onClick={() => onClient(client)} className={cn("flex w-full items-center gap-3 rounded-control px-2 py-1.5 text-left hover:bg-surface focus-visible:outline-2 focus-visible:outline-highlight", selected && "bg-surface")}>
            <span className="shrink-0 text-fg-muted">{appMark(client)}</span><span className="min-w-0 flex-1"><span className="block">{clientLabel(client)}</span>{appDetail(client) && <span className="block text-xs text-fg-muted">{appDetail(client)}</span>}</span>
            <span className="text-fg-muted tabular-nums">{count(data.facets?.apps[client])}</span>{selected && <IconCheck width={16} height={16} aria-hidden="true" />}
          </button>;
        })}
      </div>
      <div role="radiogroup" aria-label={t("usageV2.devices")} className="mt-3 border-t border-line pt-3">
        <div className="flex justify-between px-2 text-fg-muted"><span>{t("usageV2.devices")}</span><span>{t("usageV2.last30")}</span></div>
        {visibleDevices.map(device => {
          const selected = !!filter && sameDevice(filter.device, device);
          const linked = device.kind === "key" && data.inventory?.some(item => item.apiKeyId === device.id);
          return <button key={device.kind === "key" ? `key:${device.id}` : device.kind} type="button" role="radio" aria-checked={selected} tabIndex={filter && (selected || (!visibleDevices.some(item => sameDevice(filter.device, item)) && visibleDevices[0] === device)) ? 0 : -1} onClick={() => onDevice(device)} disabled={deviceLocked} className={cn("flex w-full items-center gap-3 rounded-control px-2 py-1.5 text-left hover:bg-surface focus-visible:outline-2 focus-visible:outline-highlight", selected && "bg-surface")}>
            <span className="shrink-0 text-fg-muted">{device.kind === "key" ? <HugeiconsIcon icon={LaptopIcon} size={16} aria-hidden="true" /> : device.kind === "unconfigured" ? <IconKey width={16} height={16} aria-hidden="true" /> : <IconMonitor width={16} height={16} aria-hidden="true" />}</span>
            <span className="min-w-0 flex-1"><span className="block">{deviceLabel(device)}</span>{linked && <span className="block text-xs text-fg-muted">{t("usageV2.remoteLink")}</span>}</span>
            <span className="text-fg-muted tabular-nums">{count(data.facets?.devices.find(row => sameDevice(row.device, device))?.requests)}</span>{selected && <IconCheck width={16} height={16} aria-hidden="true" />}
          </button>;
        })}
      </div>
      <p className="mb-0 mt-3 border-t border-line pt-3 text-fg-muted">{deviceLocked ? t("usageV2.locked") : t("usageV2.noKeyHelp")}</p>
      {!deviceLocked && <p className="mb-0 text-fg-muted">{t("usageV2.unconfiguredHelp")}</p>}
      <p className="mb-0 text-fg-muted">{t("usageV2.classificationHelp")}</p>
      {(data.failed || data.facets?.usageIncomplete || !facetsAllowed) && <p role="status" className="mb-0 text-fg-muted">{t("usageV2.countsUnavailable")}</p>}
    </Select.Popup>;
}
