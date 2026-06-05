# FreeLLMAPI — Architecture (Client)

**Generated:** 2026-05-31 | **Part:** client

## Executive Summary

The client is a single-page React dashboard providing a management interface for the FreeLLMAPI gateway. It includes a chat playground, API key management, fallback chain ordering, and usage analytics. Built with React 19, Vite 8, Tailwind CSS 4, and shadcn/ui components.

## Technology Stack

| Category | Technology | Version |
|----------|-----------|---------|
| Language | TypeScript | 6.0 |
| Framework | React | 19.2 |
| Build Tool | Vite | 8.0 |
| Styling | Tailwind CSS | 4.2 |
| UI Components | shadcn/ui | 4.2 |
| Base UI | @base-ui/react | 1.3 |
| Routing | React Router | 7.14 |
| Data Fetching | TanStack React Query | 5.97 |
| Charts | Recharts | 3.8 |
| Drag-and-Drop | @dnd-kit | 6.3 |
| Icons | Lucide React | 1.8 |
| Typography | Geist (Variable) | 5.2 |

## Architecture Pattern

**Component-based SPA** with page-level routing and centralized data fetching.

```
App.tsx
├── BrowserRouter
│   ├── Header (Brand + NavLinks + DarkModeToggle)
│   └── Routes
│       ├── /playground → PlaygroundPage
│       ├── /keys       → KeysPage
│       ├── /fallback   → FallbackPage
│       └── /analytics  → AnalyticsPage
└── QueryClientProvider (TanStack React Query)
```

## Pages

### PlaygroundPage
Interactive chat interface for testing the proxy endpoint. Sends requests to `/v1/chat/completions` through the unified API key.

### KeysPage
API key management dashboard:
- Add new keys with platform selector and Zod validation
- View all keys with masked display
- Toggle individual keys or all keys per platform
- Delete keys
- Health status indicators

### FallbackPage
Drag-and-drop interface for configuring the model fallback chain:
- Visual priority ordering using `@dnd-kit`
- Toggle individual models in the chain
- Real-time priority updates via PUT `/api/fallback`

### AnalyticsPage
Usage analytics dashboard with multiple views:
- Summary cards (requests, success rate, tokens, cost savings)
- Timeline charts via Recharts
- Per-platform and per-model breakdowns
- Error distribution analysis
- Time range selector (24h, 7d, 30d)

## Component Library

### shadcn/ui Primitives (`components/ui/`)
| Component | Purpose |
|-----------|---------|
| `badge.tsx` | Status indicators |
| `button.tsx` | Primary interactions |
| `card.tsx` | Content containers |
| `input.tsx` | Text input fields |
| `label.tsx` | Form labels |
| `select.tsx` | Dropdown selectors |
| `separator.tsx` | Visual dividers |
| `switch.tsx` | Toggle switches |
| `table.tsx` | Data tables |
| `textarea.tsx` | Multiline input |

### Custom Components
| Component | Purpose |
|-----------|---------|
| `page-header.tsx` | Reusable page title + description |

## Data Fetching

All API calls go through `lib/api.ts`:
```typescript
apiFetch<T>(path: string, options?: RequestInit): Promise<T>
```
- Prepends `BASE_URL` from Vite's `import.meta.env`
- Adds `Content-Type: application/json` header
- Throws structured errors matching OpenAI error format

**TanStack React Query** provides:
- Automatic caching and background refetching
- Loading/error state management
- Optimistic updates for mutations

## Theming

- **CSS Variables** in `index.css` for light/dark theme support
- **Dark mode toggle** via `document.documentElement.classList.toggle('dark')`
- **Persistence** via `localStorage.getItem('theme')`
- **System preference** detection via `prefers-color-scheme: dark`
- **Font:** Geist Variable (sans + mono)

## Build & Deployment

- **Dev:** `vite` (HMR on port 5173)
- **Build:** `tsc -b && vite build` → `client/dist/`
- **Production:** Served statically by Express from `server/src/app.ts`
