import { createElement, Fragment, type ReactNode } from "react";

/** Splits a sentence on `{slot}` markers so a JSX node can sit inside translated copy. */
export function withSlots(sentence: string, slots: Record<string, ReactNode>): ReactNode[] {
  return sentence.split(/(\{[a-zA-Z]+\})/).map((part, index) => {
    const name = /^\{([a-zA-Z]+)\}$/.exec(part)?.[1];
    return name && name in slots ? createElement(Fragment, { key: index }, slots[name]) : part;
  });
}
