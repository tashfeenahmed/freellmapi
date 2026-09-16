@import "tailwindcss";
@import "tw-animate-css";
@import "shadcn/tailwind.css";
@import "@fontsource-variable/geist";
@import "@fontsource-variable/geist-mono";

@custom-variant dark (&:is(.dark *));

@theme inline {
    --font-heading: var(--font-sans);
    --font-sans: 'Geist Variable', ui-sans-serif, system-ui, -apple-system, sans-serif;
    --font-mono: 'Geist Mono Variable', ui-monospace, SFMono-Regular, Menlo, monospace;
    --color-sidebar-ring: var(--sidebar-ring);
    --color-sidebar-border: var(--sidebar-border);
    --color-sidebar-accent-foreground: var(--sidebar-accent-foreground);
    --color-sidebar-accent: var(--sidebar-accent);
    --color-sidebar-primary-foreground: var(--sidebar-primary-foreground);
    --color-sidebar-primary: var(--sidebar-primary);
    --color-sidebar-foreground: var(--sidebar-foreground);
    --color-sidebar: var(--sidebar);
    --color-chart-5: var(--chart-5);
    --color-chart-4: var(--chart-4);
    --color-chart-3: var(--chart-3);
    --color-chart-2: var(--chart-2);
    --color-chart-1: var(--chart-1);
    --color-ring: var(--ring);
    --color-input: var(--input);
    --color-border: var(--border);
    --color-destructive: var(--destructive);
    --color-accent-foreground: var(--accent-foreground);
    --color-accent: var(--accent);
    --color-muted-foreground: var(--muted-foreground);
    --color-muted: var(--muted);
    --color-secondary-foreground: var(--secondary-foreground);
    --color-secondary: var(--secondary);
    --color-primary-foreground: var(--primary-foreground);
    --color-primary: var(--primary);
    --color-popover-foreground: var(--popover-foreground);
    --color-popover: var(--popover);
    --color-card-foreground: var(--card-foreground);
    --color-card: var(--card);
    --color-foreground: var(--foreground);
    --color-background: var(--background);
    /* --radius is 0.5rem, so: sm 4px · md 6px · lg 8px (buttons/inputs)
       · xl 12px · 2xl 16px (tables/lists) · 3xl 24px (cards) · 4xl 32px */
    --radius-sm: calc(var(--radius) * 0.5);
    --radius-md: calc(var(--radius) * 0.75);
    --radius-lg: var(--radius);
    --radius-xl: calc(var(--radius) * 1.5);
    --radius-2xl: calc(var(--radius) * 2);
    --radius-3xl: calc(var(--radius) * 3);
    --radius-4xl: calc(var(--radius) * 4);
}

:root {
    --background: oklch(0.995 0 0);
    --foreground: oklch(0.18 0 0);
    --card: oklch(1 0 0);
    --card-foreground: oklch(0.18 0 0);
    --popover: oklch(1 0 0);
    --popover-foreground: oklch(0.18 0 0);
    --primary: oklch(0.22 0 0);
    --primary-foreground: oklch(0.98 0 0);
    --secondary: oklch(0.97 0 0);
    --secondary-foreground: oklch(0.22 0 0);
    --muted: oklch(0.97 0 0);
    --muted-foreground: oklch(0.52 0 0);
    --accent: oklch(0.96 0 0);
    --accent-foreground: oklch(0.22 0 0);
    --destructive: oklch(0.577 0.245 27.325);
    --border: oklch(0.92 0 0);
    --input: oklch(0.92 0 0);
    --ring: oklch(0.55 0 0);
    --chart-1: oklch(0.28 0 0);
    --chart-2: oklch(0.45 0 0);
    --chart-3: oklch(0.6 0 0);
    --chart-4: oklch(0.75 0 0);
    --chart-5: oklch(0.87 0 0);
    --radius: 0.5rem;
    --sidebar: oklch(0.98 0 0);
    --sidebar-foreground: oklch(0.18 0 0);
    --sidebar-primary: oklch(0.22 0 0);
    --sidebar-primary-foreground: oklch(0.98 0 0);
    --sidebar-accent: oklch(0.96 0 0);
    --sidebar-accent-foreground: oklch(0.22 0 0);
    --sidebar-border: oklch(0.92 0 0);
    --sidebar-ring: oklch(0.55 0 0);
}

.dark {
    --background: oklch(0.135 0 0);
    --foreground: oklch(0.98 0 0);
    --card: oklch(0.175 0 0);
    --card-foreground: oklch(0.98 0 0);
    --popover: oklch(0.175 0 0);
    --popover-foreground: oklch(0.98 0 0);
    --primary: oklch(0.93 0 0);
    --primary-foreground: oklch(0.18 0 0);
    --secondary: oklch(0.24 0 0);
    --secondary-foreground: oklch(0.98 0 0);
    --muted: oklch(0.22 0 0);
    --muted-foreground: oklch(0.68 0 0);
    --accent: oklch(0.24 0 0);
    --accent-foreground: oklch(0.98 0 0);
    --destructive: oklch(0.704 0.191 22.216);
    --border: oklch(1 0 0 / 10%);
    --input: oklch(1 0 0 / 14%);
    --ring: oklch(0.6 0 0);
    --chart-1: oklch(0.92 0 0);
    --chart-2: oklch(0.78 0 0);
    --chart-3: oklch(0.6 0 0);
    --chart-4: oklch(0.45 0 0);
    --chart-5: oklch(0.32 0 0);
    --sidebar: oklch(0.175 0 0);
    --sidebar-foreground: oklch(0.98 0 0);
    --sidebar-primary: oklch(0.93 0 0);
    --sidebar-primary-foreground: oklch(0.18 0 0);
    --sidebar-accent: oklch(0.24 0 0);
    --sidebar-accent-foreground: oklch(0.98 0 0);
    --sidebar-border: oklch(1 0 0 / 10%);
    --sidebar-ring: oklch(0.6 0 0);
}

@layer base {
    * {
        @apply border-border outline-ring/50;
    }
    html {
        @apply font-sans antialiased;
        font-feature-settings: 'ss01', 'cv11';
        text-rendering: optimizeLegibility;
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
    }
    body {
        @apply bg-background text-foreground;
        font-feature-settings: 'ss01', 'cv11', 'tnum';
    }
    /* Desktop shell: on macOS where the window has native sidebar vibrancy,
       let the vibrancy show through a translucent backdrop so the
       dashboard reads as real glass, like the tray popover. Cards and
       popovers stay opaque on top. On Windows and Linux, keep the solid
       background so contrast and legibility are preserved. */
    html.desktop.desktop-mac body {
        background-color: transparent;
    }
    html.desktop.desktop-mac .desktop-backdrop {
        background-color: color-mix(in oklab, var(--background) 55%, transparent);
    }
    code, pre, kbd, samp {
        font-family: var(--font-mono);
        font-feature-settings: 'ss02', 'ss03';
    }
    /* Tabular numerals on any element that opts in */
    .tabular-nums {
        font-variant-numeric: tabular-nums;
    }
    /* Tighter focus ring across inputs */
    input, textarea, select {
        font-feature-settings: 'ss01';
    }
}

/* ── Syntax highlighting (highlight.js spans, see lib/highlight.ts) ─────────
   One restrained palette per theme: keywords and tags carry the accent,
   strings warm, comments recede, everything else stays the text colour. */
.code-highlight { color: var(--foreground); }
.code-highlight .hljs-comment, .code-highlight .hljs-quote { color: oklch(0.55 0 0); font-style: italic; }
.code-highlight .hljs-keyword, .code-highlight .hljs-selector-tag, .code-highlight .hljs-built_in,
.code-highlight .hljs-type, .code-highlight .hljs-literal, .code-highlight .hljs-doctag,
.code-highlight .hljs-meta { color: oklch(0.45 0.18 290); }
.code-highlight .hljs-tag, .code-highlight .hljs-name, .code-highlight .hljs-selector-class,
.code-highlight .hljs-selector-id, .code-highlight .hljs-section, .code-highlight .hljs-title { color: oklch(0.48 0.16 250); }
.code-highlight .hljs-attr, .code-highlight .hljs-attribute, .code-highlight .hljs-variable,
.code-highlight .hljs-template-variable, .code-highlight .hljs-property, .code-highlight .hljs-params { color: oklch(0.5 0.12 45); }
.code-highlight .hljs-string, .code-highlight .hljs-regexp, .code-highlight .hljs-addition,
.code-highlight .hljs-template-tag, .code-highlight .hljs-symbol, .code-highlight .hljs-bullet { color: oklch(0.5 0.14 150); }
.code-highlight .hljs-number, .code-highlight .hljs-link { color: oklch(0.5 0.15 25); }
.code-highlight .hljs-deletion { color: oklch(0.5 0.18 25); }
.code-highlight .hljs-emphasis { font-style: italic; }
.code-highlight .hljs-strong { font-weight: 600; }
.dark .code-highlight .hljs-comment, .dark .code-highlight .hljs-quote { color: oklch(0.6 0 0); }
.dark .code-highlight .hljs-keyword, .dark .code-highlight .hljs-selector-tag, .dark .code-highlight .hljs-built_in,
.dark .code-highlight .hljs-type, .dark .code-highlight .hljs-literal, .dark .code-highlight .hljs-doctag,
.dark .code-highlight .hljs-meta { color: oklch(0.78 0.12 290); }
.dark .code-highlight .hljs-tag, .dark .code-highlight .hljs-name, .dark .code-highlight .hljs-selector-class,
.dark .code-highlight .hljs-selector-id, .dark .code-highlight .hljs-section, .dark .code-highlight .hljs-title { color: oklch(0.78 0.11 240); }
.dark .code-highlight .hljs-attr, .dark .code-highlight .hljs-attribute, .dark .code-highlight .hljs-variable,
.dark .code-highlight .hljs-template-variable, .dark .code-highlight .hljs-property, .dark .code-highlight .hljs-params { color: oklch(0.8 0.1 60); }
.dark .code-highlight .hljs-string, .dark .code-highlight .hljs-regexp, .dark .code-highlight .hljs-addition,
.dark .code-highlight .hljs-template-tag, .dark .code-highlight .hljs-symbol, .dark .code-highlight .hljs-bullet { color: oklch(0.78 0.12 150); }
.dark .code-highlight .hljs-number, .dark .code-highlight .hljs-link { color: oklch(0.78 0.12 30); }
.dark .code-highlight .hljs-deletion { color: oklch(0.7 0.16 25); }
