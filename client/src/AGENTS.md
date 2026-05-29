# client — React 19 dashboard

**Relevant for:** UI changes, adding dashboard pages, styling  
**Depends on:** `shared/types.ts`, `server/src/routes/` (API endpoints the dashboard calls)

---

## Files

```
client/src/
├── main.tsx            # React DOM entry — mounts <App />
├── App.tsx             # BrowserRouter + QueryClientProvider + page routes
├── pages/
│   ├── KeysPage.tsx         # API key management
│   ├── AnalyticsPage.tsx    # Usage stats (24h/7d/30d)
│   ├── FallbackPage.tsx     # Fallback chain ordering
│   └── PlaygroundPage.tsx   # Chat completion playground
├── components/
│   ├── page-header.tsx      # Shared page title/description
│   └── ui/                  # 10 shadcn/ui primitives (button, card, dialog, input, select, table, tabs, textarea, toast, tooltip)
└── lib/
    ├── api.ts               # apiFetch<T>() — typed fetch wrapper for /api/*
    └── utils.ts             # cn() — Tailwind class merger
```

---

## Key patterns

- **Per-page API calls** — each page imports `apiFetch<T>()` from `lib/api.ts` directly. No global API layer or state store.
- **shadcn/ui + Tailwind 4** — components in `components/ui/` are copy-pasted shadcn primitives (Radix + Tailwind). Custom components go in `components/`.
- **Dark mode** via Tailwind `dark:` variants and a class-based toggle on `<html>`. No theme library.
- **Vite dev proxy** + production SPA serving: dev → `localhost:5173` proxied to `:3001`, production → Express serves `server/dist/` as static.

---

## Conventions (this directory only)

- **Import alias**: `@/` maps to `./src/` (configured in `client/vite.config.ts` and `client/tsconfig.json`).
- **No tests** — client has zero test files. Server-only coverage.
- **No state management** beyond React Query (`QueryClientProvider` in `App.tsx`). No Redux, Zustand, or Context for global state.
- **shadcn primitives are unmodified** — if you need a variant, extend via Tailwind classes at the usage site, don't edit the `.tsx` in `components/ui/`.

---

## Pitfalls

- **`apiFetch()` returns parsed JSON** — non-2xx responses throw with the error body. Handle in `.catch()` or React Query's `onError`.
- **Vite HMR** expects the server to be running (`npm run dev` starts both). Dashboard alone won't work without the API backend.
- **shadcn/ui components are large-ish files** — each includes full Radix integration + Tailwind classes. Don't duplicate them; reuse from `components/ui/`.
