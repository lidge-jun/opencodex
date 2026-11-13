/**
 * The "latest per family" view switch on model pickers (a provider's model list, the combo
 * member picker). View state of this browser only, default off; it never changes what a
 * provider serves or what a combo routes to.
 */
import { useState } from "react";

const KEY = "ocx.models.latestPerFamily.v1";

export function readLatestPerFamilyPref(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function writeLatestPerFamilyPref(on: boolean): void {
  try {
    window.localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    // Storage disabled: the switch still works for this page view.
  }
}

export function useLatestPerFamilyPref(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(readLatestPerFamilyPref);
  return [on, (next: boolean) => { writeLatestPerFamilyPref(next); setOn(next); }];
}
