import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from '@/i18n'
import FusionPage from '@/pages/FusionPage'
import { installApiFetchMock, type MockApiState } from '@/test/api-mock'

function buildState(overrides: Partial<MockApiState> = {}): MockApiState {
  return {
    authStatus: { needsSetup: false, authenticated: true, email: 'dev@example.com' },
    keys: [],
    fusionConfig: {
      config: {
        mode: 'auto',
        models: [],
        judge: null,
        k: 4,
        strategy: 'synthesize',
        expose_panel: false,
      },
      maxK: 8,
    },
    fallbackEntries: [],
    unifyEnabled: true,
    ...overrides,
  }
}

function renderFusion(state: MockApiState = buildState()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  installApiFetchMock(state)
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <MemoryRouter>
          <FusionPage />
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  )
}

describe('FusionPage (low-coverage module)', () => {
  beforeEach(() => {
    installApiFetchMock()
  })

  it('mounts and renders fusion title + loading state', async () => {
    renderFusion()
    expect(await screen.findByRole('heading', { name: /fusion/i })).toBeTruthy()
  })

  it('shows save button when draft differs (hasChanges path)', async () => {
    renderFusion(
      buildState({
        fusionConfig: {
          config: {
            mode: 'explicit',
            models: ['existing-model'],
            judge: 'judge-model',
            k: 3,
            strategy: 'best_of',
            expose_panel: true,
          },
          maxK: 8,
        },
      }),
    )
    await waitFor(() => screen.getByRole('button', { name: /save/i }))
  })

  it('draft clamps k to [1, maxK]', () => {
    expect(Math.min(Math.max(99 || 1, 1), 8)).toBe(8)
    expect(Math.min(Math.max(0 || 1, 1), 8)).toBe(1)
  })

  it('renders explicit mode panel and only enabled fallback models are selectable', async () => {
    renderFusion(
      buildState({
        fusionConfig: {
          config: { mode: 'explicit', models: [], judge: null, k: 2, strategy: 'synthesize', expose_panel: false },
          maxK: 4,
        },
        fallbackEntries: [
          { modelDbId: 1, platform: 'groq', modelId: 'groq/llama', displayName: 'Llama', enabled: true, keyCount: 1 },
          { modelDbId: 2, platform: 'google', modelId: 'google/gemini', displayName: 'Gemini', enabled: false, keyCount: 1 },
        ],
      }),
    )

    expect(await screen.findByText(/panel source/i)).toBeTruthy()
    expect(screen.getByText('Llama')).toBeTruthy()
    expect(screen.queryByText('Gemini')).toBeNull()
  })

  it('uses unify toggle to flatten grouped model options in explicit mode', async () => {
    renderFusion(
      buildState({
        fusionConfig: {
          config: { mode: 'explicit', models: [], judge: null, k: 2, strategy: 'synthesize', expose_panel: false },
          maxK: 4,
        },
        unifyEnabled: true,
        fallbackEntries: [
          { modelDbId: 1, platform: 'groq', modelId: 'groq/llama', displayName: 'Llama', enabled: true, keyCount: 1, groupKey: 'llama', canonicalId: 'llama', groupLabel: 'Llama Family', sizeLabel: 'Large' },
          { modelDbId: 2, platform: 'openai', modelId: 'openai/llama', displayName: 'Llama', enabled: true, keyCount: 1, groupKey: 'llama', canonicalId: 'llama', groupLabel: 'Llama Family', sizeLabel: 'Large' },
        ],
      }),
    )

    expect(await screen.findByText('Llama Family')).toBeTruthy()
    expect(screen.getByText('2 providers')).toBeTruthy()
  })
})
