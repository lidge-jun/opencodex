import { providerIconPaint, providerIconSrc } from "../../provider-icons";
import { cn } from "@/lib/utils";

/*
 * A small provider logo tile for the Models rail and provider cards. Same three paints as
 * the Providers page (vendor colours, a themed mask for single-ink marks, a fixed plate for
 * marks that vanish on one theme), read from the shared provider-icons module so the two
 * pages cannot disagree. A provider with no asset gets its initial on a quiet tile.
 */
export function ProviderMark({ name, className }: { name: string; className?: string }) {
  const src = providerIconSrc(name);
  const paint = providerIconPaint(src);
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-grid size-5 shrink-0 place-items-center overflow-hidden rounded-[6px] bg-raised text-fg ring-1 ring-line",
        paint === "plate" && "bg-[#f4f4f4]",
        paint === "dark-plate" && "bg-[#1c1c1c]",
        className,
      )}
    >
      {src && paint === "mask" ? (
        <span className="block size-3.5 bg-current [mask-position:center] [mask-repeat:no-repeat] [mask-size:contain]"
          style={{ maskImage: `url(${src})`, WebkitMaskImage: `url(${src})` }} />
      ) : src ? (
        <img src={src} alt="" className="block size-3.5 object-contain" />
      ) : (
        <span className="text-[11px] leading-none font-semibold uppercase">{name.slice(0, 1)}</span>
      )}
    </span>
  );
}
