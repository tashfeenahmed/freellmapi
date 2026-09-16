// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { AddModelDialog } from './add-model-dialog'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogClose: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}))
let root: Root
let container: HTMLDivElement
const onOpenChange = vi.fn()
beforeAll(() => { (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true })
beforeEach(() => {
  vi.mocked(apiFetch).mockReset().mockImplementation(async path => path === '/api/keys' ? [
    {id:7,platform:'custom',label:'Relay A',baseUrl:'https://relay-a.example/v1'},
    {id:8,platform:'custom',label:'Relay B',baseUrl:'https://relay-b.example/v1'},
    {id:9,platform:'groq',label:'Native',baseUrl:null},
  ] : {success:true})
  onOpenChange.mockReset()
  container=document.createElement('div'); document.body.appendChild(container); root=createRoot(container)
})
afterEach(() => {act(()=>root.unmount()); container.remove()})
async function flush() {for(let i=0;i<4;i++) await act(async()=>{await new Promise(r=>setTimeout(r,0))})}
async function mount() {
  const queryClient=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}})
  act(()=>root.render(<MemoryRouter><QueryClientProvider client={queryClient}><I18nProvider initialLocale="en"><AddModelDialog open onOpenChange={onOpenChange} initialPlatform="custom" /></I18nProvider></QueryClientProvider></MemoryRouter>))
  await flush()
}
function enterModel() {
  const input=container.querySelector<HTMLInputElement>('#provider-model-id')!
  act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'test-model');input.dispatchEvent(new Event('input',{bubbles:true}))})
}
function select(id:string,value:string) {
  const input=container.querySelector<HTMLSelectElement>(id)!
  act(()=>{input.value=value;input.dispatchEvent(new Event('change',{bubbles:true}))})
}
async function submit() {act(()=>{container.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))});await flush()}
const creates=()=>vi.mocked(apiFetch).mock.calls.filter(([path])=>path==='/api/models')
it('requires a custom endpoint before creating the model',async()=>{
  await mount(); enterModel(); await submit()
  expect(creates()).toHaveLength(0)
  expect(onOpenChange).not.toHaveBeenCalled()
})
it('saves the chosen endpoint key rather than guessing from provider name',async()=>{
  await mount(); enterModel(); select('#provider-endpoint-key','8'); await submit()
  expect(creates()).toHaveLength(1)
  const payload=JSON.parse(creates()[0][1]!.body as string)
  expect(payload).toMatchObject({platform:'custom',modelId:'test-model',keyId:8})
  expect(container.querySelector('#provider-endpoint-key')!.textContent).not.toContain('Native')
})
it('removes custom binding when switching back to a native provider',async()=>{
  await mount(); enterModel(); select('#provider-endpoint-key','8'); select('#provider-platform-select','groq'); await submit()
  expect(creates()).toHaveLength(1)
  const payload=JSON.parse(creates()[0][1]!.body as string)
  expect(payload.platform).toBe('groq')
  expect(payload.keyId).toBeUndefined()
})
