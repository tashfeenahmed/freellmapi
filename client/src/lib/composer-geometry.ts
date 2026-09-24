// Geometry and state rules for the Playground's liquid composer, kept pure so
// the component file holds only the component (react-refresh) and the rules
// can be unit-tested without the SVG filter stack.

/** Send button diameter, px (Tailwind size-10). */
export const COMPOSER_BUTTON_PX = 40
/** Gap between the bar and the send button once it has broken free, px. */
export const COMPOSER_GAP_PX = 8
/** Bar corner radius, px — the "corner" knob of the reference block. */
export const COMPOSER_CORNER_PX = 28
/** Goo blur sigma, px — the "bridge" knob: how far the button stretches before
 *  the liquid gives up and it breaks free. */
export const COMPOSER_BRIDGE = 3
/** Alpha-contrast slope — the "edge" knob: how sharp the liquid boundary is. */
export const COMPOSER_EDGE = 22
/** Textarea height at which the row switches to bottom alignment. */
export const COMPOSER_GROWN_PX = 44
/** Textarea height cap, px. */
export const COMPOSER_MAX_HEIGHT_PX = 160

/** Whether the composer has anything to send. */
export function composerHasContent(text: string, attachmentCount: number): boolean {
  return text.trim().length > 0 || attachmentCount > 0
}

/** THE OFFSET IS ALL ON THE BUTTON: the bar never moves. With nothing to send
 *  the button sits one diameter plus one gap to the left, i.e. entirely under
 *  the bar's right edge, so the two silhouettes are one body of liquid; with
 *  content it walks out to its resting spot at x = 0. */
export function sendButtonOffset(hasContent: boolean): number {
  return hasContent ? 0 : -(COMPOSER_BUTTON_PX + COMPOSER_GAP_PX)
}

/** The button is only a target once it has emerged and nothing is in flight. */
export function sendButtonInteractive(hasContent: boolean, loading: boolean): boolean {
  return hasContent && !loading
}

/** Auto-grow: the height to give the textarea for its current scroll height,
 *  and whether that counts as "grown" for row alignment. */
export function composerHeight(scrollHeight: number): { height: number; grown: boolean } {
  const height = Math.min(Math.max(0, scrollHeight), COMPOSER_MAX_HEIGHT_PX)
  return { height, grown: height > COMPOSER_GROWN_PX }
}
