# FreeLLMAPI — Component Inventory (Client)

**Generated:** 2026-05-31

## Pages (Route-Level Components)

| Component | Route | Purpose | Data Source |
|-----------|-------|---------|-------------|
| `PlaygroundPage` | `/playground` | Chat testing interface | `/v1/chat/completions` |
| `KeysPage` | `/keys` | API key management | `/api/keys` |
| `FallbackPage` | `/fallback` | Fallback chain ordering | `/api/fallback` |
| `AnalyticsPage` | `/analytics` | Usage analytics dashboard | `/api/analytics/*` |

## Layout Components

| Component | Location | Purpose |
|-----------|----------|---------|
| `App` | `App.tsx` | Root layout with nav, routing, query provider |
| `Brand` | `App.tsx` (inline) | Logo + project name |
| `NavItem` | `App.tsx` (inline) | Navigation link with active state |
| `DarkModeToggle` | `App.tsx` (inline) | Theme switcher with localStorage persistence |
| `PageHeader` | `components/page-header.tsx` | Reusable page title + description |

## shadcn/ui Primitives (`components/ui/`)

| Component | Purpose | Design System |
|-----------|---------|---------------|
| `Badge` | Status/tag indicators | `cva` variants: default, secondary, destructive, outline |
| `Button` | Interactive buttons | `cva` variants: default, destructive, outline, secondary, ghost, link |
| `Card` | Content containers | Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter |
| `Input` | Text input fields | Standard HTML input with theme styling |
| `Label` | Form labels | Accessible label with `@base-ui/react` |
| `Select` | Dropdown selectors | `@base-ui/react` Select + Portal + Positioner |
| `Separator` | Visual dividers | Horizontal/vertical with `orientation` prop |
| `Switch` | Toggle switches | `@base-ui/react` Switch with thumb |
| `Table` | Data tables | Table, TableHeader, TableBody, TableRow, TableHead, TableCell |
| `Textarea` | Multiline input | Standard HTML textarea with theme styling |

## Utility Libraries

| File | Exports | Purpose |
|------|---------|---------|
| `lib/api.ts` | `apiFetch<T>()` | Generic fetch wrapper with error parsing |
| `lib/utils.ts` | `cn()` | `clsx` + `tailwind-merge` class utility |

## Third-Party Component Usage

| Library | Used In | Purpose |
|---------|---------|---------|
| `@dnd-kit/core` + `@dnd-kit/sortable` | `FallbackPage` | Drag-and-drop chain reordering |
| `recharts` | `AnalyticsPage` | Bar/line charts for usage visualization |
| `lucide-react` | Multiple pages | SVG icon library |
| `react-router-dom` | `App.tsx` | Client-side routing |
| `@tanstack/react-query` | All pages | Data fetching and caching |
