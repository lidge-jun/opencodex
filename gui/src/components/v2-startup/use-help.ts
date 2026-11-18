import { useId, useState } from "react";

/** State for a "?" disclosure: the plain state stays on screen, the explanation opens below. */
export function useHelp() {
  const [open, setOpen] = useState(false);
  const id = useId();
  return { open, id, toggle: () => setOpen(value => !value) };
}
