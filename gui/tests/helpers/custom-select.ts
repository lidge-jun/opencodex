/**
 * Drives the app's `Select` (ui.tsx) the way a user does: click the trigger, click an
 * option. Native `<select>` is banned in `src/` (form-controls-rule.test.ts), so tests that
 * used to set `.value` and dispatch `change` go through these instead.
 *
 * The trigger carries the committed value in `data-value`; each option carries its own.
 * The listbox is portaled to `document.body`, so options are looked up in the trigger's
 * document through `aria-controls`, never under the component's container.
 */
import { act } from "react";

/** A Select trigger (`button[role=combobox]`) found by CSS selector under `scope`. */
export function selectTrigger(scope: ParentNode, selector: string): HTMLButtonElement {
  const trigger = scope.querySelector<HTMLButtonElement>(selector);
  if (!trigger) throw new Error(`no Select trigger matches ${selector}`);
  if (trigger.getAttribute("role") !== "combobox") throw new Error(`${selector} is not a Select trigger`);
  return trigger;
}

/** The committed value, as a native select's `.value` would report it. */
export function selectValue(trigger: Element): string {
  return trigger.getAttribute("data-value") ?? "";
}

function listbox(trigger: HTMLButtonElement): HTMLElement | null {
  const id = trigger.getAttribute("aria-controls");
  return id ? trigger.ownerDocument.getElementById(id) : null;
}

async function ensureOpen(trigger: HTMLButtonElement): Promise<HTMLElement> {
  if (trigger.getAttribute("aria-expanded") !== "true") await act(async () => { trigger.click(); });
  const list = listbox(trigger);
  if (!list) throw new Error("Select did not open (disabled, or no options)");
  return list;
}

function options(list: HTMLElement): HTMLButtonElement[] {
  return [...list.querySelectorAll<HTMLButtonElement>("[role=option]")];
}

/** Every option as `{ value, label, disabled }`, read by opening and closing the menu. */
export async function selectOptions(trigger: HTMLButtonElement): Promise<{ value: string; label: string; disabled: boolean }[]> {
  const list = await ensureOpen(trigger);
  const rows = options(list).map(option => ({
    value: option.getAttribute("data-value") ?? "",
    label: option.textContent ?? "",
    disabled: option.getAttribute("aria-disabled") === "true",
  }));
  await act(async () => { trigger.click(); });
  return rows;
}

/** The option values, in order, like `[...select.options].map(o => o.value)`. */
export async function selectOptionValues(trigger: HTMLButtonElement): Promise<string[]> {
  return (await selectOptions(trigger)).map(option => option.value);
}

/**
 * Chooses the option whose value is `value` (or whose visible text is `label`) and fires the
 * component's `onChange`. Throws when the option is missing or disabled, as a user could not
 * pick it either.
 */
export async function chooseOption(trigger: HTMLButtonElement, pick: string | { label: string }): Promise<void> {
  const list = await ensureOpen(trigger);
  const option = options(list).find(item => typeof pick === "string"
    ? item.getAttribute("data-value") === pick
    : item.textContent === pick.label);
  if (!option) throw new Error(`Select has no option ${JSON.stringify(pick)}`);
  if (option.getAttribute("aria-disabled") === "true") throw new Error(`Select option ${JSON.stringify(pick)} is disabled`);
  await act(async () => { option.click(); });
}
