import type { Plugin } from 'vite'

// Dev-only in-memory mock of the /api surface the Fallback page needs, so the
// frontend can be exercised without a running backend. Enabled only when the
// dev server is started with MOCK_API=1 (see vite.config.ts) — never bundled.

const PRESETS: Record<string, { reliability: number; speed: number; intelligence: number }> = {
  balanced: { reliability: 0.5, speed: 0.25, intelligence: 0.25 },
  smartest: { reliability: 0.35, speed: 0.1, intelligence: 0.55 },
  fastest: { reliability: 0.35, speed: 0.55, intelligence: 0.1 },
  reliable: { reliability: 0.7, speed: 0.15, intelligence: 0.15 },
}

interface MockModel {
  modelDbId: number
  platform: string
  modelId: string
  displayName: string
  sizeLabel: string
  intelligenceRank: number
  speedRank: number
  monthlyTokenBudget: string
  supportsVision: boolean
  rpmLimit: number | null
  rpdLimit: number | null
  enabled: boolean
  priority: number
  reliability: number
  speed: number
  intelligence: number
  headroom: number
  rateLimit: number
  totalRequests: number
}

let strategy = 'balanced'
// User-tuned vector for the 'custom' strategy (kept normalized, like the server).
let customWeights = { ...PRESETS.balanced }

function activeWeights() {
  if (strategy === 'custom') return customWeights
  return PRESETS[strategy] ?? PRESETS.balanced
}

const models: MockModel[] = [
  { modelDbId: 1, platform: 'google', modelId: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', sizeLabel: 'Frontier', intelligenceRank: 1, speedRank: 8, monthlyTokenBudget: '~12M', supportsVision: true, rpmLimit: 5, rpdLimit: 100, enabled: true, priority: 1, reliability: 0.94, speed: 0.55, intelligence: 1.0, headroom: 1, rateLimit: 1, totalRequests: 412 },
  { modelDbId: 2, platform: 'groq', modelId: 'openai/gpt-oss-120b', displayName: 'GPT-OSS 120B', sizeLabel: 'Frontier', intelligenceRank: 6, speedRank: 2, monthlyTokenBudget: '~6M', supportsVision: false, rpmLimit: 30, rpdLimit: 1000, enabled: true, priority: 2, reliability: 0.9, speed: 0.98, intelligence: 0.72, headroom: 1, rateLimit: 0.7, totalRequests: 833 },
  { modelDbId: 3, platform: 'cerebras', modelId: 'llama-3.3-70b', displayName: 'Llama 3.3 70B', sizeLabel: 'Large', intelligenceRank: 4, speedRank: 1, monthlyTokenBudget: '~50M', supportsVision: false, rpmLimit: 30, rpdLimit: 14400, enabled: true, priority: 3, reliability: 0.88, speed: 1.0, intelligence: 0.5, headroom: 1, rateLimit: 1, totalRequests: 256 },
  { modelDbId: 4, platform: 'google', modelId: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', sizeLabel: 'Large', intelligenceRank: 4, speedRank: 5, monthlyTokenBudget: '~3M', supportsVision: true, rpmLimit: 10, rpdLimit: 20, enabled: true, priority: 4, reliability: 0.97, speed: 0.78, intelligence: 0.52, headroom: 0.45, rateLimit: 1, totalRequests: 90 },
  { modelDbId: 5, platform: 'nvidia', modelId: 'llama-4-scout', displayName: 'Llama 4 Scout', sizeLabel: 'Medium', intelligenceRank: 7, speedRank: 4, monthlyTokenBudget: '~30M', supportsVision: true, rpmLimit: 40, rpdLimit: null, enabled: true, priority: 5, reliability: 0.7, speed: 0.83, intelligence: 0.33, headroom: 1, rateLimit: 1, totalRequests: 47 },
  { modelDbId: 6, platform: 'openrouter', modelId: 'deepseek/deepseek-v3.1:free', displayName: 'DeepSeek V3.1', sizeLabel: 'Frontier', intelligenceRank: 2, speedRank: 10, monthlyTokenBudget: '~6M', supportsVision: false, rpmLimit: 20, rpdLimit: 200, enabled: false, priority: 6, reliability: 0.5, speed: 0.4, intelligence: 0.67, headroom: 1, rateLimit: 1, totalRequests: 0 },
  { modelDbId: 7, platform: 'mistral', modelId: 'mistral-large', displayName: 'Mistral Large', sizeLabel: 'Large', intelligenceRank: 5, speedRank: 6, monthlyTokenBudget: '~15M', supportsVision: false, rpmLimit: 60, rpdLimit: 500, enabled: true, priority: 7, reliability: 0.82, speed: 0.6, intelligence: 0.45, headroom: 1, rateLimit: 1, totalRequests: 178 },
]

function budgetTokens(label: string): number {
  const m = label.match(/~?([\d.]+)(?:-([\d.]+))?([MK])?/)
  if (!m) return 0
  const n = parseFloat(m[2] ?? m[1])
  const unit = m[3] === 'M' ? 1_000_000 : m[3] === 'K' ? 1_000 : 1
  return n * unit
}

function score(m: MockModel): number {
  const w = activeWeights()
  const base = w.reliability * m.reliability + w.speed * m.speed + w.intelligence * m.intelligence
  return base * m.headroom * m.rateLimit
}

function readBody(req: any): Promise<any> {
  return new Promise(resolve => {
    let data = ''
    req.on('data', (c: any) => { data += c })
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')) } catch { resolve({}) } })
  })
}

export function mockApiPlugin(): Plugin {
  return {
    name: 'freellmapi-dev-mock',
    configureServer(server) {
      server.middlewares.use(async (req: any, res: any, next: any) => {
        const url = (req.url || '').split('?')[0]
        if (!url.startsWith('/api/')) return next()
        const send = (obj: any, status = 200) => {
          res.statusCode = status
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(obj))
        }

        // Auth gate — always "logged in" in mock mode.
        if (url === '/api/auth/status') return send({ needsSetup: false, authenticated: true, email: 'dev@local' })
        if (url === '/api/ping') return send({ status: 'ok', timestamp: new Date().toISOString() })

        if (url === '/api/fallback' && req.method === 'GET') {
          const rows = [...models].sort((a, b) => a.priority - b.priority).map(m => ({
            modelDbId: m.modelDbId, priority: m.priority, effectivePriority: m.priority,
            penalty: m.rateLimit < 1 ? Math.round((1 - m.rateLimit) * 10) : 0,
            rateLimitHits: m.rateLimit < 1 ? 3 : 0,
            enabled: m.enabled, platform: m.platform, modelId: m.modelId, displayName: m.displayName,
            intelligenceRank: m.intelligenceRank, speedRank: m.speedRank, sizeLabel: m.sizeLabel,
            rpmLimit: m.rpmLimit, rpdLimit: m.rpdLimit, monthlyTokenBudget: m.monthlyTokenBudget,
            supportsVision: m.supportsVision, keyCount: 3,
          }))
          return send(rows)
        }

        if (url === '/api/fallback' && req.method === 'PUT') {
          const body = await readBody(req)
          for (const e of body as any[]) {
            const m = models.find(x => x.modelDbId === e.modelDbId)
            if (m) { m.priority = e.priority; m.enabled = e.enabled }
          }
          return send({ success: true })
        }

        if (url === '/api/fallback/routing' && req.method === 'GET') {
          const scores = [...models]
            .map(m => ({
              modelDbId: m.modelDbId, platform: m.platform, modelId: m.modelId, displayName: m.displayName,
              enabled: m.enabled, reliability: m.reliability, speed: m.speed, intelligence: m.intelligence,
              headroom: m.headroom, rateLimit: m.rateLimit, score: score(m), totalRequests: m.totalRequests,
            }))
            .sort((a, b) => b.score - a.score)
          return send({ strategy, weights: strategy === 'priority' ? null : activeWeights(), customWeights, scores })
        }

        if (url === '/api/fallback/routing' && req.method === 'PUT') {
          const body = await readBody(req)
          if (typeof body.strategy === 'string') strategy = body.strategy
          if (body.weights && typeof body.weights === 'object') {
            const { reliability = 0, speed = 0, intelligence = 0 } = body.weights
            const sum = reliability + speed + intelligence
            if (sum > 0) {
              customWeights = { reliability: reliability / sum, speed: speed / sum, intelligence: intelligence / sum }
            }
          }
          return send({ strategy, presets: PRESETS, customWeights })
        }

        if (url === '/api/fallback/token-usage') {
          const withKeys = models
          const modelBudgets = withKeys.map(m => ({ displayName: m.displayName, platform: m.platform, budget: budgetTokens(m.monthlyTokenBudget) }))
          const totalBudget = modelBudgets.reduce((s, m) => s + m.budget, 0)
          return send({ totalBudget, totalUsed: Math.round(totalBudget * 0.18), models: modelBudgets })
        }

        // Anything else under /api → empty 200 so pages don't hard-crash.
        return send({})
      })
    },
  }
}
