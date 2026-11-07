import { useId, useState } from "react";

/** State for one "?" disclosure: the button reads `open`/`toggle`, the region its `id`. */
export function useHelp() {
  const [open, setOpen] = useState(false);
  const id = useId();
  return { open, id, toggle: () => setOpen(value => !value) };
}
