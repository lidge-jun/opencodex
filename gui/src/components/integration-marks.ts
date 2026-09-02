/**
 * The mark for every row the Integrations page can show, and the set of assets
 * that must be drawn as a themed mask rather than an image.
 *
 * Why this is not just `CLIENT_MARKS`: the Integrations page reaches four rows
 * that are not export clients at all -- Codex CLI routing, Claude Code, Claude
 * Desktop and the Grok fence. Those ids live in a different namespace that
 * happens to overlap on the string "claude", so one map keyed by
 * `OverviewClientId` is the only shape that can serve the page.
 *
 * `MASKED_MARKS` is keyed by ASSET PATH, deliberately, where
 * `MONOCHROME_CLIENT_MARKS` is keyed by client id. `kimi-color.svg` is reachable
 * both as a provider icon and as a client mark; a path-keyed set cannot mask it
 * on one surface and leave it unmasked on another, which is exactly the
 * inconsistency a second id-keyed set would invite.
 */
import { CLIENT_MARKS, MONOCHROME_CLIENT_MARKS, type ExportClientId } from "./apikeys-workspace/client-config-clients";
import type { OverviewClientId } from "../pages/integrations/overview-clients";

/**
 * The four rows with no export client behind them.
 *
 * Codex takes the OpenAI mark because Codex CLI ships no mark of its own and
 * OpenAI publishes it. Claude Desktop shares Claude's: they are one brand and
 * two surfaces, and inventing a distinct mark for the desktop app would imply a
 * distinction that does not exist.
 */
const NATIVE_MARKS: Record<Exclude<OverviewClientId, ExportClientId>, string> = {
  codex: "/provider-icons/openai.svg",
  claude: "/provider-icons/claude-color.svg",
  claudeDesktop: "/provider-icons/claude-color.svg",
  grok: "/provider-icons/grok.svg",
  // Two-ink brand artwork, drawn as an image (never masked).
  cursor: "/provider-icons/cursor-color.svg",
};

/**
 * Every Integrations row to its mark. Exhaustive over `OverviewClientId`, so a
 * client added to the page without an asset decision is a compile error rather
 * than a silent monogram.
 *
 * A value may still be null: that is the honest answer for a client whose
 * vendor publishes nothing usable, and `ClientMark` renders a monogram for it.
 * Today none are, which `integration-marks.test.ts` pins.
 */
export const INTEGRATION_MARKS: Record<OverviewClientId, string | null> = {
  ...NATIVE_MARKS,
  opencode: CLIENT_MARKS.opencode ?? null,
  pi: CLIENT_MARKS.pi ?? null,
  omp: CLIENT_MARKS.omp ?? null,
  hermes: CLIENT_MARKS.hermes ?? null,
  openclaw: CLIENT_MARKS.openclaw ?? null,
  kimi: CLIENT_MARKS.kimi ?? null,
  gajae: CLIENT_MARKS.gajae ?? null,
  dsh: CLIENT_MARKS.dsh ?? null,
  mcode: CLIENT_MARKS.mcode ?? null,
  zcode: CLIENT_MARKS.zcode ?? null,
  prime: CLIENT_MARKS.prime ?? null,
  aside: CLIENT_MARKS.aside ?? null,
};

/**
* Assets whose artwork is one neutral ink, so the ink has to come from the theme.
*
 * The export-client half is derived from `MONOCHROME_CLIENT_MARKS` rather than
 * restated, because two hand-maintained lists of the same fact drift.
*
 * `openai.svg` looks like it belongs here and does not: it is a single fill, but
 * that fill is #10A37F -- OpenAI's brand green. Masking repaints a trademark in
 * the theme's text color, the same reason `dsh` stays an image despite being
 * single-ink.
 */
/**
 * The neutral-ink marks that belong to no export client.
 *
 * `MONOCHROME_CLIENT_MARKS` is keyed by `ExportClientId`, so it structurally
 * cannot carry a native row's asset. Grok is a native row, which is the only
 * reason its mark needs a second home rather than an entry there.
 *
 * `grok.svg` is one `#000000` fill on transparency. Measured on the dark card
 * surface (`rgb(48,48,48)`) that is about 1.9:1 -- the glyph is very nearly gone,
 * which a zoomed capture confirms. An earlier pass left it as an image on the
 * grounds that masking would be editing someone else's mark; that reasoning does
 * not survive contact with what masking is. The file is not modified. It is read
 * as a shape and painted in the surrounding text color, which is how xAI renders
 * it on their own dark surfaces. Flattening does not apply either: there is one
 * ink to flatten.
 *
 * `openai.svg` still does not belong here, and the distinction is not neutrality
 * in the abstract -- it is that #10A37F IS the brand. Repainting it loses
 * information a reader uses to identify the mark. #000000 carries none.
 */
const MASKED_NATIVE_MARKS: readonly string[] = [NATIVE_MARKS.grok];

export const MASKED_MARKS: ReadonlySet<string> = new Set([
  ...[...MONOCHROME_CLIENT_MARKS].map(clientId => CLIENT_MARKS[clientId]).filter((src): src is string => src !== undefined),
  ...MASKED_NATIVE_MARKS,
]);

/** The mark for a row, or null when it has none. */
export function markFor(clientId: OverviewClientId): string | null {
  return INTEGRATION_MARKS[clientId];
}
