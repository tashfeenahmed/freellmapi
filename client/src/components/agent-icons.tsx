import type { ReactNode, SVGProps } from 'react'
import { cn } from '@/lib/utils'

// Brand marks for the tools listed on the Agents page. Every mark below is the
// tool's own published logo, taken verbatim from the source in the table and
// changed in only two ways: it is scaled and centred onto the shared 24px grid
// used by the rest of the icons, and it is painted in that brand's own colour
// for the tile it sits on. No mark is redrawn, recomposed or restyled.
//
// The marks identify tools this server is compatible with. They remain the
// trademarks of their respective owners and imply no affiliation or endorsement.
//
// COLOUR RULE — one rule for the whole set, applied in this order:
//   1. Use the brand's own artwork colour. Where a brand publishes separate
//      artwork for light and dark backgrounds (most of these do) the matching
//      variant is used verbatim on each tile — that is the `published pair`
//      treatment below.
//   2. Where a brand publishes one value only and it falls under 3:1 against
//      the tile it has to sit on, that value is moved in OKLCH lightness only:
//      hue is held exactly, chroma is held and clamped to the sRGB gamut, and
//      lightness stops at the first step that clears 3:1. The mark still reads
//      as that brand's colour. Only claude, aider and kilo need this, and only
//      on one tile each; the untouched brand hex is kept on the other tile.
//   3. `generic` is not a brand — it stays `currentColor`.
//
// Contrast is measured against the tile itself, `bg-muted`, which resolves to
// #F5F5F5 in light and #1B1B1B in dark. Ratios are in the second table.
//
//   id        tool         source                                                          licence
//   claude    Claude Code  simple-icons `claude` (claude.ai; the code.claude.com mark)      CC0-1.0
//   codex     Codex CLI    developers.openai.com/codex site header (OpenAI's own asset)     OpenAI TM, nominative use
//   cline     Cline        simple-icons `cline`; colours from cline.bot/assets/branding/    CC0-1.0 + Cline TM
//                          logos/cline-wordmark-{black,white}.svg
//   continue  Continue     continuedev/continue `docs/logo/{light,dark}.svg`                Apache-2.0
//   aider     Aider        Aider-AI/aider `aider/website/assets/icons/safari-pinned-tab.svg`;  Apache-2.0
//                          colours sampled from `android-chrome-192x192.png` (only raster)
//   opencode  OpenCode     anomalyco/opencode `packages/identity/mark{,-light}.svg`         MIT
//   goose     Goose        block/goose `documentation/static/img/goose.svg`, with the       Apache-2.0
//                          published `goose-logo-white.png` as the dark variant
//   qwen      Qwen Code    simple-icons `qwen` (qwen.ai)                                    CC0-1.0
//   roo       Roo Code     RooCodeInc/Roo-Code `src/assets/icons/icon.svg`; colours from    Apache-2.0
//                          docs `img/roo-code-logo-{dark,white}.svg`
//   kilo      Kilo Code    Kilo-Org/kilocode `packages/kilo-console/public/kilo-logo.svg`   MIT
//   cursor    Cursor       cursor.com/brand asset pack, `Cube/SVG/CUBE_2D_{LIGHT,DARK}.svg` Cursor TM, nominative use
//   crush     Crush        no vector published; hue sampled from the official               Charm TM, nominative use
//                          stuff.charm.sh/crush/charm-crush.png (Charm's `charple`)
//   dsh       DeepSeek     lettermark only: DSH's brand guidelines ask third parties not    DeepSeek TM, nominative use
//             Harness      to reuse official artwork; tinted with DeepSeek's brand blue
//   mimo      MiMo Code    lettermark only: no vector published, only the 32px favicon      Xiaomi TM, nominative use
//                          at cdn.cnbj1.fds.api.mi-img.com/.../mimo.ico, which is flat black
//   atomcode  AtomCode     lettermark only: no vector published; hue sampled from the        AtomGit TM, nominative use
//                          app icon cdn-news.gitcode.com/news/atomcode-icon1.png (the
//                          gradient's dominant blue, at two of its four corners)
//
//   id        light tile        ratio  dark tile         ratio  dark-mode treatment
//   claude    #D37152            3.08  #D97757            5.52  brand #D97757 on dark; light tile is
//                                                               the same hue tuned down (rule 2, 2.86→3.08)
//   codex     #000000           19.26  #FFFFFF           17.22  published pair (OpenAI paints the mark in
//                                                               currentColor: black on light, white on dark)
//   cline     #18181B           16.25  #FAFAFA           16.50  published pair (black/white wordmarks)
//   continue  #000000           19.26  #FFFFFF           17.22  published pair (logo/light.svg, logo/dark.svg)
//   aider     #07A160            3.07  #02F191           11.48  brand green on dark; light tile is the same
//                                                               hue tuned down (rule 2, 1.38→3.07)
//   opencode  #17181C + #E6E5E6 16.27  #FFFFFF + #5A5858 17.22  published pair; the second value is the
//                                                               mark's own inner block, a depth fill that is
//                                                               deliberately near-invisible in the brand's
//                                                               own artwork too (1.15 / 2.44) — the frame
//                                                               carries the legibility
//   goose     #101010           17.45  #FFFFFF           17.22  published pair (black mark / white logo)
//   qwen      #6950EF            4.82  #6950EF            3.28  brand hex unchanged; it clears 3:1 on both
//                                                               tiles, so no tuning is applied
//   roo       #000000           19.26  #FFFFFF           17.22  published pair (logo-dark.svg/logo-white.svg)
//   kilo      #949107            3.05  #FAF74F           15.16  brand yellow on dark; light tile is the same
//                                                               hue tuned down (rule 2, 1.04→3.05) — #FAF74F
//                                                               is oklch(0.95 0.18 108.4) and the tuned value
//                                                               is oklch(0.638 0.136 108.4), the most
//                                                               saturated yellow that clears 3:1 there
//   cursor    #26251E           14.10  #EDECEC           14.61  published pair (CUBE_2D_LIGHT/DARK)
//   crush     #6B50FF            4.57  #6B50FF            3.46  brand purple unchanged; clears on both tiles
//   dsh       #4D6BFE            3.97  #4D6BFE            3.98  brand blue unchanged; clears on both tiles
//   mimo      #000000           19.26  #FFFFFF           17.22  published pair (the favicon is black artwork on
//                                                               transparent, so it inverts on the dark tile)
//   atomcode  #3C82F6            3.37  #3C82F6            4.69  icon blue unchanged; clears on both tiles
//   generic   currentColor         —   currentColor         —   not a brand mark
//
// Cursor also publishes a 2.5D cube in five warm greys (#43413c #55544f #72716d
// #d6d5d2 #fff). It is not used: at 20px the facets stop resolving, and its
// darkest and lightest faces drop out on the dark and light tile respectively.
// The 2D cube is an official mark in its own right, not a flattening of that one.
//
// OpenCode's mark is the only two-tone one. Its inner block was dropped while
// the set was monochrome — it would have merged with the frame — and is restored
// here from the same published artwork, so the mark keeps both of its layers.
//
// Aider's and Kilo Code's logos are published as light artwork knocked out of a
// dark plate; both are used here as the plain letterform the plate carries, which
// is the same geometry with the background dropped for the colour swap.
//
// Crush has no published vector mark (charmbracelet/crush ships the icon as a
// PNG only), so it keeps the lettermark fallback below rather than an invented
// symbol; it is tinted with Charm's own purple so it sits in the coloured row.
// `generic` is not a brand: it is our own terminal glyph, on the same lucide grid
// and weight as the icons used elsewhere in the app.

type Brand = {
  // Tailwind arbitrary properties set `--mk` (and `--mk2` for the one two-tone
  // mark) on the tile. The `dark:` half swaps in the dark-tile value, so the
  // whole colour scheme is CSS — no theme hook, no flash on first paint.
  tint: string
  // Optical size correction, applied about the centre on top of the geometry
  // already fitted to the grid; omitted means the mark is used at its fitted
  // size. A bright saturated fill blooms next to a near-black or white one, so
  // aider's #02F191 and kilo's #FAF74F — the two most luminous colours in the
  // set, both on blocky marks — are pulled in slightly. Measured on the
  // rendered tile as perceptual ink coverage, both sat ~1.5 points above the
  // set's median and land on it at these values. Nothing is scaled up: every
  // other mark already fills 21–24 of the 24-unit grid, so there is no room.
  scale?: number
  art?: ReactNode
}

const brands: Record<string, Brand> = {
  claude: {
    tint: '[--mk:#D37152] dark:[--mk:#D97757]',
    art: (
      <path
        d="m4.67 15.8 4.67-2.62 0.08-0.23-0.08-0.13h-0.23l-0.78-0.05-2.67-0.07-2.31-0.1-2.24-0.12-0.56-0.12-0.53-0.7 0.05-0.35 0.47-0.32 0.68 0.06 1.5 0.1 2.25 0.16 1.63 0.1 2.42 0.25h0.38l0.05-0.16-0.13-0.1-0.1-0.1L6.89 9.98l-2.52-1.67-1.32-0.96-0.72-0.49-0.36-0.46-0.16-1 0.65-0.72 0.87 0.06 0.22 0.06 0.88 0.68 1.89 1.46 2.46 1.82 0.36 0.3 0.14-0.1 0.02-0.07-0.16-0.27-1.34-2.42-1.43-2.46-0.64-1.02-0.17-0.61c-0.06-0.25-0.1-0.46-0.1-0.72L6.22 0.37 6.62 0.24l0.99 0.13 0.41 0.36 0.61 1.4 0.99 2.21 1.54 3 0.45 0.89 0.24 0.82 0.09 0.25h0.16v-0.14l0.13-1.69 0.23-2.07 0.23-2.67 0.08-0.75 0.37-0.9 0.74-0.49 0.58 0.28 0.47 0.68-0.07 0.44-0.28 1.83-0.55 2.87-0.36 1.92h0.21l0.24-0.24 0.97-1.29 1.63-2.04 0.72-0.81 0.84-0.9 0.54-0.43h1.02l0.75 1.12-0.34 1.15-1.05 1.33-0.87 1.13-1.25 1.68-0.78 1.35 0.07 0.11 0.19-0.02 2.82-0.6 1.53-0.28 1.82-0.31 0.82 0.38 0.09 0.39-0.32 0.8-1.95 0.48-2.28 0.46-3.4 0.81-0.04 0.03 0.05 0.06 1.53 0.14 0.66 0.04h1.6l2.99 0.22 0.78 0.52 0.47 0.63-0.08 0.48-1.2 0.61-1.62-0.38-3.79-0.9-1.3-0.32h-0.18v0.11l1.08 1.06 1.98 1.79 2.48 2.31 0.13 0.57-0.32 0.45-0.34-0.05-2.18-1.64-0.84-0.74-1.91-1.6h-0.13v0.17l0.44 0.64 2.32 3.49 0.12 1.07-0.17 0.35-0.6 0.21-0.66-0.12-1.36-1.91L14.23 18.02l-1.13-1.92-0.14 0.08-0.67 7.18-0.31 0.37-0.72 0.28-0.6-0.46-0.32-0.74 0.32-1.46 0.38-1.91 0.31-1.51 0.28-1.88 0.17-0.63-0.01-0.04-0.14 0.02-1.42 1.95-2.16 2.92-1.71 1.83-0.41 0.16-0.71-0.37 0.07-0.66 0.4-0.58 2.36-3.01 1.42-1.86 0.92-1.08-0.01-0.16h-0.05l-6.28 4.08-1.12 0.14-0.48-0.45 0.06-0.74 0.23-0.24 1.89-1.3Z"
      />
    ),
  },
  codex: {
    tint: '[--mk:#000000] dark:[--mk:#FFFFFF]',
    art: (
      <path
        d="M9.46 9.06v-2.07c0-0.17 0.07-0.31 0.22-0.39l4.16-2.4c0.57-0.33 1.24-0.48 1.94-0.48 2.62 0 4.27 2.03 4.27 4.19 0 0.15 0 0.33-0.02 0.5L15.72 5.87c-0.26-0.15-0.52-0.15-0.78 0L9.46 9.06Zm9.72 8.07V12.18c0-0.31-0.13-0.52-0.39-0.68L13.32 8.32l1.79-1.02c0.15-0.09 0.28-0.09 0.44 0l4.16 2.4c1.2 0.7 2.01 2.18 2.01 3.62 0 1.66-0.98 3.18-2.53 3.82Zm-11.01-4.36-1.79-1.05c-0.15-0.09-0.22-0.22-0.22-0.39V6.53c0-2.33 1.79-4.1 4.21-4.1 0.92 0 1.77 0.31 2.49 0.85l-4.3 2.49c-0.26 0.15-0.39 0.37-0.39 0.68v6.32ZM12.02 14.99l-2.56-1.44V10.5L12.02 9.06l2.56 1.44v3.05L12.02 14.99Zm1.65 6.63c-0.92 0-1.77-0.31-2.49-0.85l4.3-2.49c0.26-0.15 0.39-0.37 0.39-0.68V11.28l1.81 1.05c0.15 0.09 0.22 0.22 0.22 0.39v4.8c0 2.33-1.81 4.1-4.23 4.1v0Zm-5.17-4.86-4.16-2.4c-1.2-0.7-2.01-2.18-2.01-3.62 0-1.68 1-3.18 2.55-3.82v4.97c0 0.31 0.13 0.52 0.39 0.68l5.45 3.16-1.79 1.02c-0.15 0.09-0.28 0.09-0.44 0ZM8.26 20.33c-2.46 0-4.27-1.85-4.27-4.14 0-0.17 0.02-0.35 0.04-0.52L8.33 18.15c0.26 0.15 0.52 0.15 0.78 0l5.47-3.16v2.07c0 0.17-0.07 0.31-0.22 0.39L10.2 19.85c-0.57 0.33-1.24 0.48-1.94 0.48h0Zm5.41 2.59c2.64 0 4.84-1.88 5.34-4.36C21.45 17.93 23.02 15.64 23.02 13.31c0-1.53-0.65-3.01-1.83-4.08 0.11-0.46 0.17-0.92 0.17-1.37 0-3.12-2.53-5.45-5.45-5.45-0.59 0-1.16 0.09-1.72 0.28C13.21 1.73 11.86 1.12 10.38 1.12c-2.64 0-4.84 1.88-5.34 4.36C2.59 6.11 1.02 8.4 1.02 10.74c0 1.53 0.65 3.01 1.83 4.08-0.11 0.46-0.17 0.92-0.17 1.37 0 3.12 2.53 5.45 5.45 5.45 0.59 0 1.16-0.09 1.72-0.28 0.98 0.96 2.33 1.57 3.82 1.57Z"
      />
    ),
  },
  cline: {
    tint: '[--mk:#18181B] dark:[--mk:#FAFAFA]',
    art: (
      <path
        d="m18.42 10.69-1.14-2.28V8.97c0-2.18-1.75-3.94-3.91-3.94h-1.94c0.14-0.29 0.22-0.61 0.22-0.96A2.18 2.18 0 0 0 12.2 1.88a2.18 2.18 0 0 0-2.18 2.19c0 0.34 0.08 0.67 0.22 0.96H8.3c-2.16 0-3.91 1.76-3.91 3.94v1.31L3.23 12.57c-0.12 0.23-0.12 0.5 0 0.73l1.16 2.25v1.31C4.39 19.04 6.14 20.8 8.3 20.8h7.81c2.16 0 3.91-1.76 3.91-3.94V15.55l1.14-2.26c0.11-0.23 0.11-0.49 0-0.72m-10.13 1.86a1.79 1.79 0 0 1-1.78 1.79 1.79 1.79 0 0 1-1.78-1.79v-3.19A1.79 1.79 0 0 1 9.23 9.45a1.79 1.79 0 0 1 1.78 1.79zm5.74 0a1.79 1.79 0 0 1-1.78 1.79 1.79 1.79 0 0 1-1.78-1.79v-3.19A1.79 1.79 0 0 1 14.97 9.45a1.79 1.79 0 0 1 1.78 1.79z"
      />
    ),
  },
  continue: {
    tint: '[--mk:#000000] dark:[--mk:#FFFFFF]',
    art: (
      <path
        d="M19.28 4.39L18.05 6.52L21.15 11.88C21.17 11.92 21.19 11.97 21.19 12.01C21.19 12.06 21.17 12.11 21.15 12.15L18.05 17.51L19.28 19.64L23.68 12.01L19.28 4.39V4.39ZM17.58 6.24L18.8 4.12H16.35L15.13 6.24H17.58H17.58ZM15.13 6.79L17.99 11.74H20.44L17.58 6.79H15.13ZM17.58 17.24L20.44 12.29H17.99L15.13 17.24H17.58ZM15.13 17.79L16.35 19.91H18.8L17.58 17.79H15.12H15.13ZM6.82 20.43C6.77 20.43 6.73 20.42 6.69 20.4C6.65 20.37 6.61 20.34 6.59 20.3L3.49 14.93H1.04L5.44 22.55H14.24L13.01 20.43H6.83H6.82ZM13.49 20.16L14.71 22.28L15.94 20.15L14.71 18.03L13.49 20.15V20.16ZM14.24 17.76H8.53L7.3 19.88H13.01L14.24 17.76ZM8.05 17.49L5.19 12.53L3.96 14.66L6.82 19.61L8.05 17.49ZM1.03 14.38H3.48L4.71 12.26H2.26L1.03 14.38ZM6.57 3.74C6.6 3.7 6.63 3.67 6.67 3.65C6.71 3.62 6.76 3.61 6.81 3.61H13.01L14.23 1.48H5.42L1.02 9.11H3.47L6.56 3.75L6.57 3.74ZM4.71 11.78L3.48 9.66H1.03L2.26 11.78H4.71ZM6.81 4.43L3.96 9.38L5.18 11.51L8.04 6.56L6.81 4.43ZM13.01 4.16H7.29L8.51 6.28H14.23L13.01 4.16ZM14.71 6L15.93 3.88L14.71 1.76L13.49 3.88L14.71 6Z"
      />
    ),
  },
  aider: {
    tint: '[--mk:#07A160] dark:[--mk:#02F191]',
    scale: 0.96,
    art: (
      <path
        d="M14.78 0.67c0.12 0.12 0.17 0.72 0.18 2.38l0.01 1.82 1.29 0.03c0.71 0.02 1.3 0.05 1.33 0.07 0.02 0.02 0.06 0.28 0.09 0.57 0.03 0.29 0.1 0.75 0.15 1.03 0.1 0.51 0.1 0.48-0.1 1.39-0.08 0.4-0.08 2.18 0.01 2.62 0.13 0.6 0.13 0.95 0.03 1.48-0.14 0.73-0.14 2.17 0.01 2.74 0.14 0.53 0.14 1.27 0.01 1.97-0.05 0.29-0.1 0.65-0.1 0.79l0 0.26 1.21 0c0.66 0 1.24 0.02 1.29 0.05 0.06 0.04 0.11 0.3 0.16 0.89 0.05 0.45 0.1 0.91 0.12 1 0.04 0.23-0.14 2.16-0.22 2.31-0.06 0.11-0.13 0.11-1.28 0.1-0.81-0.01-1.24-0.04-1.29-0.08-0.13-0.13-0.2-1.8-0.13-3 0.04-0.61 0.05-1.13 0.03-1.16-0.05-0.08-2.49-0.07-2.58 0.01-0.07 0.07-0.05 0.87 0.05 1.56 0.05 0.33 0.05 0.57 0.01 0.84-0.04 0.21-0.08 0.59-0.1 0.86-0.05 0.74-0.08 0.84-0.25 0.92-0.11 0.05-1.3 0.07-4.06 0.07l-3.91 0-0.07-0.2c-0.19-0.58-0.26-2.01-0.16-3.19 0.03-0.33 0.04-0.68 0.01-0.77l-0.04-0.16-1.16 0c-1.26 0-1.51-0.02-1.56-0.17-0.07-0.2-0.1-2.34-0.04-3.12 0.09-1.11-0.01-1.04 1.55-1.08 0.69-0.02 1.27-0.05 1.3-0.07 0.02-0.02 0.01-0.31-0.03-0.63-0.04-0.32-0.1-0.78-0.13-1-0.04-0.33-0.03-0.54 0.07-1.02 0.06-0.33 0.13-0.78 0.16-0.99 0.02-0.22 0.06-0.43 0.09-0.47 0.04-0.07 0.77-0.09 3.98-0.11l3.93-0.03 0.05-0.18c0.03-0.11 0.02-0.43-0.02-0.78-0.07-0.69-0.04-2.07 0.07-2.72 0.06-0.36 0.06-0.45-0.01-0.49-0.05-0.03-1.79-0.05-3.89-0.05l-3.8 0-0.16-0.15c-0.11-0.1-0.16-0.2-0.16-0.34 0-0.11-0.03-0.52-0.06-0.91-0.06-0.77 0.03-2.69 0.13-2.82 0.03-0.04 0.16-0.08 0.28-0.09 0.47-0.04 7.66-0.02 7.7 0.02z"
      />
    ),
  },
  opencode: {
    tint: '[--mk:#17181C] [--mk2:#E6E5E6] dark:[--mk:#FFFFFF] dark:[--mk2:#5A5858]',
    art: (
      <>
        <path fill="var(--mk2)" d="M15.68 10.26v7.04H8.35v-7.04z" />
        <path d="M19.35 20.82H4.68V3.22h14.67zM15.68 6.74H8.35v10.56h7.33z" />
      </>
    ),
  },
  goose: {
    tint: '[--mk:#101010] dark:[--mk:#FFFFFF]',
    art: (
      <path
        d="M23.8 21.2L21.9 19.7C20.9 18.9 20 17.9 19.3 16.7 18.4 15.2 17.1 13.8 15.5 12.9L14.8 12.4C14.5 12.2 14.3 12 14.3 11.6 14.3 11.4 14.3 11.3 14.5 11.1 14.9 10.5 17 8.2 17.4 7.9 17.8 7.5 18.4 7.2 18.9 6.8 19 6.8 19 6.7 19.1 6.7 19.3 6.5 19.4 6.4 19.5 6.2 20.1 5.6 20.1 5 20.1 5 20 4.8 19.8 4.4 19.4 4.2 19.8 4.1 20.2 4.3 20.4 4.5 20.7 4.1 20.8 3.9 21.1 3.4 21.1 3.3 21.2 3.2 21 3 20.9 2.9 20.7 2.9 20.6 3 20 3.3 19.5 3.6 19 3.9 19 3.9 18.5 3.9 17.8 4.5 17.6 4.6 17.5 4.8 17.4 4.9 17.3 5 17.2 5.1 17.2 5.1 16.8 5.6 16.5 6.2 16.1 6.7 15.8 7 13.5 9.2 12.9 9.6 12.8 9.7 12.6 9.7 12.4 9.7 12.1 9.7 11.8 9.5 11.6 9.2L11.2 8.5C10.2 6.9 8.9 5.6 7.3 4.7 6.2 4 5.2 3.2 4.3 2.1L2.8 0.3C2.7 0.2 2.6 0.2 2.5 0.3 2.3 0.6 2 1.4 1.7 2.3 1.7 2.3 1.7 2.4 1.7 2.4 2.1 2.8 2.8 3.6 3.7 4.3 3.7 4.4 3.7 4.5 3.6 4.5 2.9 4.3 2.1 3.9 1.6 3.7 1.5 3.6 1.5 3.7 1.5 3.7 1.4 4.4 1.4 5.2 1.4 6 1.4 6 1.5 6 1.5 6 2.1 6.3 3.1 6.7 4.2 6.9 4.3 7 4.3 7.1 4.2 7.1 3.4 7.2 2.5 7.3 1.8 7.3 1.7 7.3 1.7 7.3 1.7 7.4 1.9 7.9 2.1 8.4 2.3 8.9 2.4 9.1 2.5 9.3 2.6 9.5 2.7 9.6 2.7 9.6 2.7 9.6 3.3 9.6 4 9.5 4.7 9.4 4.8 9.4 4.9 9.5 4.8 9.6 4.3 9.9 3.8 10.2 3.4 10.4 3.3 10.4 3.3 10.5 3.3 10.6 3.6 11 3.9 11.3 4.2 11.7 4.2 11.7 5.9 13.4 5.9 13.5 6.9 12.5 8.5 11.4 10.2 10.5 7.9 12.4 6.6 13.8 5.9 14.6L5.5 15.2C5.2 15.6 5 15.9 4.8 16.3 4.3 17.5 3.3 20.1 3.3 20.1 3.2 20.3 3.3 20.5 3.4 20.6 3.6 20.7 3.8 20.8 4 20.7 4 20.7 6.5 19.8 7.7 19.2 8.1 19 8.5 18.8 8.8 18.6L9.5 18C9.9 17.8 10.4 17.8 10.7 18.2L12.4 19.8C12.7 20.1 13.1 20.4 13.4 20.7 13.5 20.8 13.6 20.7 13.6 20.7 13.8 20.2 14.1 19.7 14.4 19.2 14.5 19.1 14.7 19.2 14.6 19.3 14.5 20 14.5 20.7 14.4 21.3 14.4 21.3 14.4 21.4 14.5 21.4 14.7 21.5 14.9 21.6 15.2 21.7 15.7 22 16.2 22.2 16.7 22.3 16.7 22.3 16.8 22.3 16.8 22.2 16.8 21.5 16.8 20.7 16.9 19.8 17 19.8 17.1 19.8 17.1 19.8 17.3 20.9 17.7 21.9 18 22.5 18 22.6 18 22.6 18.1 22.6 18.9 22.7 19.6 22.7 20.3 22.6 20.4 22.6 20.4 22.5 20.4 22.5 20.1 21.9 19.8 21.2 19.5 20.4 19.5 20.3 19.6 20.3 19.7 20.3 20.4 21.2 21.2 22 21.6 22.3 21.7 22.3 21.7 22.3 21.7 22.3 22.7 22 23.4 21.7 23.7 21.5 23.8 21.5 23.9 21.3 23.8 21.3L23.8 21.2Z"
      />
    ),
  },
  qwen: {
    tint: '[--mk:#6950EF] dark:[--mk:#6950EF]',
    art: (
      <path
        d="M22.73 14.3 19.94 9.48l1.32-2.29a0.5 0.5 0 0 0 0-0.51l-1.47-2.54a0.51 0.51 0 0 0-0.44-0.25h-5.58L12.46 1.6a0.51 0.51 0 0 0-0.44-0.26H9.09a0.5 0.5 0 0 0-0.44 0.26L5.86 6.43h-2.64a0.5 0.5 0 0 0-0.44 0.26L1.31 9.22a0.5 0.5 0 0 0 0 0.51L4.1 14.56l-1.32 2.29a0.5 0.5 0 0 0 0 0.51l1.47 2.54a0.51 0.51 0 0 0 0.44 0.25h5.57l1.32 2.29a0.51 0.51 0 0 0 0.44 0.26h2.93a0.51 0.51 0 0 0 0.44-0.26l2.79-4.83h2.64a0.51 0.51 0 0 0 0.44-0.25l1.47-2.54a0.49 0.49 0 0 0 0-0.51M9.09 1.85l1.47 2.54-1.47 2.54H20.83L19.36 9.48H7.91L6.3 6.68Zm1.17 17.79-5.57 0 1.47-2.54h2.93L3.22 6.94h2.93q2.86 4.96 5.72 9.91zm9.09-5.08L17.89 12.02l-5.87 10.16-1.47-2.54c1.91-3.3 3.82-6.6 5.73-9.91h3.23l2.79 4.83z"
      />
    ),
  },
  roo: {
    tint: '[--mk:#000000] dark:[--mk:#FFFFFF]',
    art: (
      <path
        d="M19.48 5.42l-0.43 1.56c-0.02 0.08-0.11 0.13-0.19 0.1l-7.01-2.17c-0.05-0.01-0.1 0-0.14 0.03l-7.21 5.79c-0.02 0.02-0.04 0.03-0.07 0.03l-4.3 0.66c-0.08 0.01-0.13 0.08-0.13 0.16l0.03 0.62c0 0.08 0.06 0.14 0.14 0.14l5 0.31c0.03 0 0.05 0 0.08-0.01l3.65-1.84c0.05-0.03 0.11-0.02 0.16 0.01l2.34 1.75c0.04 0.03 0.06 0.07 0.06 0.12l-0.02 2.9c0 0.03 0.01 0.06 0.03 0.09l3.67 5.27c0.03 0.04 0.07 0.06 0.12 0.06h1.25c0.11 0 0.19-0.12 0.13-0.22l-2.71-4.96c-0.02-0.04-0.02-0.1 0-0.14l1.37-2.61c0.01-0.03 0.04-0.05 0.06-0.06l4.87-2.47c0.05-0.02 0.11-0.02 0.15 0.01l1.4 0.93c0.02 0.02 0.05 0.02 0.08 0.02h1.28c0.12 0 0.19-0.13 0.13-0.23l-3.54-5.86c-0.07-0.11-0.24-0.09-0.28 0.04Z"
      />
    ),
  },
  kilo: {
    tint: '[--mk:#949107] dark:[--mk:#FAF74F]',
    scale: 0.95,
    art: (
      <path
        d="M16.43 19.72H19.95V22.53H15.52L13.61 20.62V16.2H16.43V19.72ZM22.76 15.29L20.85 13.38H16.43V16.2L19.95 16.2V19.72H22.76V15.29ZM10.79 13.38H7.98V16.2H10.79V13.38ZM1.64 20.62L3.55 22.53H10.79V19.72H4.46V13.38H1.64V20.62ZM19.57 7.75V3.33L17.66 1.41H13.61V4.23H16.76V7.75H13.61V10.57H22.76V7.75H19.57ZM4.46 1.41H1.64V10.57H4.46V7.4H7.98V10.57H10.79V7.4L7.98 4.58H4.46V1.41ZM10.79 1.41H7.98V4.58H10.79V1.41Z"
      />
    ),
  },
  cursor: {
    tint: '[--mk:#26251E] dark:[--mk:#EDECEC]',
    art: (
      <path
        d="M11.83 2.32 4.08 6.79a0.68 0.68 0 0 0-0.34 0.59v9.03c0 0.24 0.13 0.46 0.34 0.58l7.75 4.48a0.81 0.81 0 0 0 0.81 0l7.75-4.48a0.68 0.68 0 0 0 0.34-0.58V7.38a0.68 0.68 0 0 0-0.34-0.59L12.63 2.32a0.81 0.81 0 0 0-0.8 0M4.69 7.32h14.96c0.21 0 0.35 0.23 0.24 0.42L12.42 20.7c-0.05 0.09-0.18 0.05-0.18-0.05V12.16a0.48 0.48 0 0 0-0.24-0.41l-7.35-4.24c-0.09-0.05-0.05-0.19 0.05-0.19"
      />
    ),
  },
  // No vector mark exists, so the lettermark fallback stands in — tinted with
  // Charm's own purple so the tile still carries the brand.
  crush: {
    tint: '[--mk:#6B50FF] dark:[--mk:#6B50FF]',
  },
  // DeepSeek Harness asks third parties not to reuse its official artwork
  // (BRAND_GUIDELINES.md), so the lettermark stands in, in DeepSeek's blue.
  dsh: {
    tint: '[--mk:#4D6BFE] dark:[--mk:#4D6BFE]',
  },
  // Xiaomi publishes no vector mark for MiMo Code — the only artwork on
  // mimo.xiaomi.com is the 32px favicon — so the lettermark stands in. That
  // favicon is drawn in flat black on transparent, which is the published
  // pair treatment: black on the light tile, white on the dark one.
  mimo: {
    tint: '[--mk:#000000] dark:[--mk:#FFFFFF]',
  },
  // AtomGit publishes AtomCode's icon only as a raster (the app icon the site
  // header uses: an atom orbit on a cyan-to-violet gradient), so the lettermark
  // stands in. It is tinted with the gradient's dominant blue, sampled from
  // that PNG, which clears 3:1 on both tiles as published.
  atomcode: {
    tint: '[--mk:#3C82F6] dark:[--mk:#3C82F6]',
  },
  // Any other OpenAI-compatible client: our own terminal glyph, not a brand
  // mark, so it keeps the page foreground colour on both tiles.
  generic: {
    tint: '',
    art: (
      <g fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <rect x="2.8" y="4.3" width="18.4" height="15.4" rx="3.6" />
        <path d="M7.6 10.4 10.1 12.9 7.6 15.4" />
        <path d="M12.6 15.4h4.4" />
      </g>
    ),
  },
}

function Mark({
  scale,
  children,
  ...props
}: SVGProps<SVGSVGElement> & { scale?: number; children: ReactNode }) {
  return (
    // `--mk` is set by the tile below; the fallback keeps an untinted mark on
    // the page foreground colour rather than leaving it unpainted.
    <svg viewBox="0 0 24 24" fill="var(--mk, currentColor)" aria-hidden="true" {...props}>
      {scale
        ? <g transform={`translate(12 12) scale(${scale}) translate(-12 -12)`}>{children}</g>
        : children}
    </svg>
  )
}

// Letters for a tool with no mark yet, so a catalog entry added later still
// gets a badge of the same size and weight instead of an empty tile.
function lettermark(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase()
}

export function AgentIcon({
  id,
  name,
  className,
}: {
  id: string
  name: string
  className?: string
}) {
  const brand = brands[id]
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground',
        brand?.tint,
        className,
      )}
    >
      {brand?.art
        ? <Mark className="size-5" scale={brand.scale}>{brand.art}</Mark>
        : (
            <span
              className="font-mono text-[11px] font-semibold"
              style={{ color: 'var(--mk, currentColor)' }}
            >
              {lettermark(name)}
            </span>
          )}
    </span>
  )
}
