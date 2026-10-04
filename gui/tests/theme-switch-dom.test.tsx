import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ThemeSwitch, type ThemeMode } from "../src/components/theme-switch";
import { en } from "../src/i18n/en";
import { ko } from "../src/i18n/ko";
import { LanguageProvider } from "../src/i18n/provider";
import { getActiveLocale, setActiveLocale, type Locale } from "../src/i18n/shared";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
const modes: ThemeMode[] = ["light", "dark", "system"];
let previous: Record<(typeof globals)[number], unknown>;
let previousLocale: Locale;
let root: Root | null = null;

function mount(theme: ThemeMode, onChange: (mode: ThemeMode) => void, locale: "en" | "ko" = "en") {
  previousLocale = getActiveLocale();
  const win = new Window({ url: "http://127.0.0.1:10100/" });
  previous = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof previous;
  win.localStorage.setItem("ocx-lang", locale);
  // Earlier DOM suites may leave non-writable globals; keep ours writable for later suites.
  Object.defineProperties(globalThis, {
    document: { configurable: true, writable: true, value: win.document },
    window: { configurable: true, writable: true, value: win },
    navigator: { configurable: true, writable: true, value: win.navigator },
    localStorage: { configurable: true, writable: true, value: win.localStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, writable: true, value: true },
  });
  const host = win.document.createElement("div") as never as HTMLElement;
  win.document.body.appendChild(host as never);
  root = createRoot(host);
  const render = (mode: ThemeMode) => act(() => {
    root!.render(<LanguageProvider><ThemeSwitch theme={mode} onChange={onChange} /></LanguageProvider>);
  });
  render(theme);
  return { host, render };
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  for (const k of globals) Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: previous?.[k] });
  setActiveLocale(previousLocale);
});

for (const [locale, dict] of [["en", en], ["ko", ko]] as const) {
  test(`theme choices have ordered ${locale} accessible names and decorative icons`, () => {
    const { host } = mount("system", () => {}, locale);
    const group = host.querySelector('[role="group"]');
    expect(group?.classList.contains("theme-switch")).toBe(true);
    expect(group?.getAttribute("aria-label")).toBe(dict["theme.label"]);
    const buttons = Array.from(group!.querySelectorAll("button"));
    expect(buttons).toHaveLength(3);
    expect(buttons.map(button => button.getAttribute("aria-label"))).toEqual(modes.map(mode => dict[`theme.${mode}`]));
    buttons.forEach((button, index) => {
      expect(button.type).toBe("button");
      expect(button.classList.contains("theme-switch__btn")).toBe(true);
      expect(button.title).toBe(dict[`theme.${modes[index]!}`]);
      expect(button.textContent?.trim()).toBe("");
      expect(button.querySelectorAll("svg")).toHaveLength(1);
      expect(button.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    });
  });
}

test("exactly the controlled theme is pressed, including after re-render", () => {
  const { host, render } = mount("light", () => {});
  for (const mode of modes) {
    render(mode);
    const buttons = Array.from(host.querySelectorAll("button"));
    expect(buttons.map(button => button.getAttribute("aria-pressed"))).toEqual(modes.map(choice => String(choice === mode)));
    expect(host.querySelectorAll('[aria-pressed="true"]')).toHaveLength(1);
  }
});

test("dark, system and light clicks report their own mode", () => {
  const calls: ThemeMode[] = [];
  const { host } = mount("light", mode => calls.push(mode));
  const [light, dark, system] = Array.from(host.querySelectorAll("button"));
  for (const button of [dark, system, light]) act(() => { button!.click(); });
  expect(calls).toEqual(["dark", "system", "light"]);
  // Selection stays controlled by the prop until the parent re-renders.
  expect(light!.getAttribute("aria-pressed")).toBe("true");
  expect(host.querySelectorAll('[aria-pressed="true"]')).toHaveLength(1);
});
