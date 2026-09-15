// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import { apiFetch } from '@/lib/api'
import KeysPage from '@/pages/KeysPage'
import type { ProviderQuotaState, QuotaOutlookPool, QuotaOutlookResponse } from '../../../../shared/types'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))
vi.mock('./provider-list', () => ({ ProviderList: () => null }))
vi.mock('./provider-checklist-section', () => ({ ProviderChecklistSection: () => null }))
vi.mock('./add-key-dialog', () => ({ AddKeyDialog: () => null }))
vi.mock('./export-keys-dialog', () => ({ ExportKeysDialog: () => null }))

let root: Root
let container: HTMLDivElement
let client: QueryClient
let response: QuotaOutlookResponse
let raw: ProviderQuotaState[]
const pool = (overrides: Partial<QuotaOutlookPool> = {}): QuotaOutlookPool => ({
  platform:'groq',pool:'groq::account',limit:250,remaining:35,remainingPct:14,
  observedAt:'2026-09-14 19:59:00',resetAt:'2026-09-15T00:00:00Z',ratePerMin:.7,
  recentRequestCount:7,unavailableReason:null,estimatedExhaustionAt:'2026-09-14T20:50:00Z',status:'forecast',warning:'low_balance',...overrides,
})
beforeAll(() => { (globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true })
beforeEach(() => {
  response={generatedAt:'2026-09-14T20:00:00Z',observationWindowMinutes:10,minimumRequests:3,pools:[pool()]}
  raw=Array.from({length:25},(_,i)=>({platform:'groq',keyId:i+1,keyLabel:'Saved key '+(i+1),quotaPoolKey:'groq::account',metric:i===24?'tokens':'requests',limit:250,remaining:35,resetAt:null,resetStrategy:'unknown',source:'header',confidence:1,notes:null,observedAt:'2026-09-14 19:59:00',updatedAt:'2026-09-14 19:59:00'}))
  vi.mocked(apiFetch).mockReset().mockImplementation(async path=>path==='/api/keys'?[]:path==='/api/health'?{quotaStates:raw}:response)
  client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}})
  container=document.createElement('div');document.body.appendChild(container);root=createRoot(container)
})
afterEach(()=>{act(()=>root.unmount());client.clear();container.remove()})
async function flush(){for(let i=0;i<4;i++)await act(async()=>{await new Promise(resolve=>setTimeout(resolve,0))})}
async function mount(){
  act(()=>root.render(<MemoryRouter><QueryClientProvider client={client}><I18nProvider initialLocale="en"><KeysPage /></I18nProvider></QueryClientProvider></MemoryRouter>))
  await flush()
}
async function openQuota(){
  const tab=[...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(el=>el.textContent==='Quota signals')!
  act(()=>tab.click());await flush()
}
it('loads forecasts only when the existing Quota signals tab opens and retains every raw signal',async()=>{
  await mount()
  expect(vi.mocked(apiFetch).mock.calls.some(([path])=>path==='/api/fallback/quota-forecast')).toBe(false)
  await openQuota()
  expect(vi.mocked(apiFetch).mock.calls.some(([path])=>path==='/api/fallback/quota-forecast')).toBe(true)
  expect(container.textContent).toContain('Low balance')
  expect(container.textContent).toContain('0.7 req/min')
  expect(container.textContent).toContain('in 50 minutes')
  expect(container.querySelector('details')?.textContent).toContain('Saved key 25')
  expect(container.querySelector('details')?.textContent).toContain('tokens')
  expect(container.querySelector('details')?.open).toBe(false)
})
it('shows the reset-first, soon-to-run-out and unknown states without inventing forecasts',async()=>{
  response.pools=[pool({platform:'openrouter',pool:'openrouter::free',remaining:75,remainingPct:30,warning:'exhausting_soon'}),
    pool({platform:'cerebras',pool:'cerebras::shared',status:'resets_first',warning:null,estimatedExhaustionAt:null}),
    pool({platform:'aihorde',pool:'aihorde::anonymous',status:'unknown',unavailableReason:'quota_not_reported',warning:null,remaining:null,remainingPct:null,limit:null,ratePerMin:0,estimatedExhaustionAt:null,resetAt:null})]
  await mount();await openQuota()
  expect(container.textContent).toContain('Running low soon')
  expect(container.textContent).toContain('Not before reset')
  const unknown=container.querySelector('article[aria-label="AI Horde (no key needed, slow)"]')!
  expect(unknown.textContent).toContain('Unavailable')
  expect(unknown.textContent).toContain('Local usage is shown')
  expect(unknown.querySelector('[role="progressbar"]')).toBeNull()
})
it('labels stale balances as last reported and exhausted windows explicitly',async()=>{
  response.pools=[pool({status:'stale',unavailableReason:'stale_observation',warning:null,ratePerMin:0,estimatedExhaustionAt:null}),
    pool({platform:'cerebras',pool:'cerebras::shared',remaining:0,remainingPct:0,status:'exhausted',estimatedExhaustionAt:null})]
  await mount();await openQuota()
  expect(container.textContent).toContain('Needs fresh data')
  expect(container.textContent).toContain('requests last reported')
  expect(container.textContent).toContain('Already exhausted')
})
it('keeps raw observations available on failure and retries the forecast request',async()=>{
  let failed=true
  vi.mocked(apiFetch).mockImplementation(async path=>{
    if(path==='/api/fallback/quota-forecast'&&failed)throw new Error('offline')
    return path==='/api/keys'?[]:path==='/api/health'?{quotaStates:raw}:response
  })
  await mount();await openQuota()
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not load')
  expect(container.querySelector('details')?.textContent).toContain('Saved key 25')
  failed=false
  act(()=>[...container.querySelectorAll<HTMLButtonElement>('button')].find(el=>el.textContent==='Retry')!.click());await flush()
  expect(container.querySelector('[role="alert"]')).toBeNull()
  expect(container.textContent).toContain('Quota pools needing attention: 1')
})
it('shows an empty forecast without hiding the raw token observations',async()=>{
  response.pools=[]
  await mount();await openQuota()
  expect(container.querySelectorAll('article')).toHaveLength(0)
  expect(container.querySelector('details')?.textContent).toContain('Saved key 25')
})

it('shows coverage and local usage even when all provider quotas are unavailable',async()=>{
  response.pools=[pool({platform:'kilo',pool:'kilo::anonymous',status:'unknown',unavailableReason:'quota_not_reported',
    warning:null,limit:null,remaining:null,remainingPct:null,resetAt:null,estimatedExhaustionAt:null,recentRequestCount:2,ratePerMin:.2})]
  await mount();await openQuota()
  expect(container.textContent).toContain('Forecast unavailable')
  expect(container.textContent).not.toContain('No forecast warnings')
  expect(container.textContent).toContain('Forecasts available for 0 of 1 pools')
  expect(container.textContent).toContain('2 successful requests through this instance in the last 10 minutes')
  expect(container.textContent).toContain('at least 3 successful requests within 10 minutes')
  expect(container.textContent).toContain('0.2 req/min')
  const unavailable=[...container.querySelectorAll('details')].find(el=>el.querySelector('summary')?.textContent==='Unavailable quota pools (1)')!
  expect(unavailable.open).toBe(false)
  act(()=>unavailable.querySelector('summary')!.click());await flush()
  expect(unavailable.open).toBe(true)
  expect([...container.querySelectorAll('details')].find(el=>el.querySelector('summary')?.textContent==='Raw quota observations')?.textContent).toContain('Saved key 25')
})
it('explains missing resets independently of low traffic and shows usable pools before unavailable ones',async()=>{
  response.pools=[pool({platform:'cerebras',pool:'cerebras::shared',status:'unavailable',unavailableReason:'reset_not_reported',
    warning:null,resetAt:null,estimatedExhaustionAt:null,recentRequestCount:10,ratePerMin:1}),pool()]
  await mount();await openQuota()
  expect(container.querySelector('article')?.getAttribute('aria-label')).toBe('Groq')
  expect(container.textContent).toContain('Forecasts available for 1 of 2 pools')
  const cerebras=container.querySelector('article[aria-label="Cerebras"]')!
  expect(cerebras.textContent).toContain('did not report a valid reset time')
  expect(cerebras.textContent).not.toContain('at least 3')
})
