declare const authorizeMutation: (kind: string) => boolean;
declare const mutate: () => void;
declare const observe: () => boolean;
declare const wait: () => Promise<boolean>;

export function allowed() { if (!authorizeMutation("runtime")) return; mutate(); }
export async function staleAwait() { if (!authorizeMutation("runtime")) return; await wait(); mutate(); }
export function staleBlocking() { if (!authorizeMutation("runtime")) return; observe(); mutate(); }
export function wrongBranch() { if (!authorizeMutation("runtime")) mutate(); }
export function nestedClosure() { const later = () => authorizeMutation("runtime"); mutate(); return later; }
export function nonterminalDenial() { if (!authorizeMutation("runtime")) { if (observe()) return; } mutate(); }
export function unguardedSecondAction() { if (!authorizeMutation("runtime")) return; mutate(); mutate(); }
export async function awaitInCondition() { if (authorizeMutation("runtime") && await wait()) mutate(); }
export async function freshAfterAwait() { await wait(); if (!authorizeMutation("runtime")) return; mutate(); }
