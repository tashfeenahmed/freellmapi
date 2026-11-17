import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check, ChevronDown, CircleArrowRight, Ellipsis, Plug, Search, Terminal } from 'lucide-react'
import { AgentIcon } from '@/components/agent-icons'
import { CopyButton } from '@/components/copy-button'
import { useI18n } from '@/i18n'
import { apiFetch } from '@/lib/api'
import catalog from '@/data/agent-tools.json'
import { isTerminalAgent, type AgentSetupBridge, type SetupError, type SetupFile } from '../../../shared/agent-setup'
import { useRecentAgents } from './useRecentAgents'
import './desktop-agents.css'

type Tool = typeof catalog[number]
type Panel = 'details' | 'guide' | 'quit' | 'saved' | null
const featured = ['claude', 'cline', 'opencode', 'codex', 'continue', 'aider']
const tools = [...featured.map(id => catalog.find(tool => tool.id === id)!), ...catalog.filter(tool => !featured.includes(tool.id))]
const surfaces: Record<string, string> = {
  cline: 'Editor', continue: 'Editor', roo: 'Editor', cursor: 'Editor', generic: 'API',
  kilo: 'Editor / CLI', opencode: 'CLI / Desktop', goose: 'CLI / Desktop', zcode: 'Desktop / CLI',
  reasonix: 'CLI / Desktop', openclaw: 'Agent', hermes: 'Agent',
}

export function desktopAgentBridge() {
  return (window as Window & { __FREEAPI_AGENT_SETUP__?: AgentSetupBridge }).__FREEAPI_AGENT_SETUP__
}

function GatewayKey({ command }: { command?: string }) {
  const { t } = useI18n()
  const [show, setShow] = useState(false)
  const { data, isError } = useQuery<{ apiKey: string }>({
    queryKey: ['api-key'], queryFn: () => apiFetch('/api/settings/api-key'), enabled: show,
  })
  const value = show && data ? data.apiKey : '••••••••••••'
  const windows = (window as Window & { __FREEAPI_PLATFORM__?: string }).__FREEAPI_PLATFORM__ === 'win32'
  const quoted = windows ? value.replaceAll("'", "''") : value.replaceAll("'", "'\\''")
  const snippet = command
    ? (windows ? '$env:FREELLMAPI_API_KEY = ' : 'export FREELLMAPI_API_KEY=') + "'" + quoted + "'\n" + command
    : value
  return <div className="key-field">
    <code>{show && isError ? t('common.error') : snippet}</code>
    <button className="subbutton" onClick={() => setShow(!show)}>{t(show ? 'common.hide' : 'common.show')} {t('agents.apiKey')}</button>
    {show && data && <CopyButton text={snippet} label={t('common.copy')} className="size-7" />}
  </div>
}

function Files({ files }: { files: SetupFile[] }) {
  const { t } = useI18n()
  return <ul>{files.map(file => <li key={file.path}>
    <code>{file.path}</code>
    {file.backupPath && <div className="minor">{t('backups.title')} <code>{file.backupPath}</code></div>}
  </li>)}</ul>
}

interface CardState { panel: Panel; saved?: SetupFile[]; paths?: SetupFile[]; error?: SetupError; launched?: boolean }
function AgentCard({ tool, bridge, state, update, active, activate, seen }: {
  active: boolean; activate: () => void; seen: boolean
  tool: Tool; bridge: AgentSetupBridge; state: CardState; update: (values: Partial<CardState>) => void
}) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const { id, name } = tool
  const { saved, paths } = state
  const panel = active ? state.panel : null
  const error = active ? state.error : undefined
  const terminal = isTerminalAgent(id)
  const restart = id === 'openclaw' || id === 'hermes'
  const follow = restart || id === 'roo'
  const docs = <a href={tool.docsUrl} target="_blank" rel="noopener noreferrer">{name} · {t('agents.documentation')} ↗</a>
  const origin = window.location.origin
  async function perform(action: keyof AgentSetupBridge) {
    setBusy(true)
    try {
      const result = await bridge[action](id)
      if (!result.ok) { update({ error: result.error }); return }
      if (action === 'details') update({ panel: 'details', paths: result.files, error: undefined })
      else if (action === 'connect') update({ panel: tool.configType === 'guide' ? 'guide' : 'saved', saved: tool.configType === 'guide' ? undefined : result.files, error: undefined })
      else update({ launched: true, error: undefined })
    } catch { update({ error: action === 'launch' ? 'terminal' : 'config' }) }
    finally { setBusy(false) }
  }
  function connect() {
    activate()
    if (saved && panel !== 'details' && panel !== 'quit') {
      update({ panel: 'saved', error: undefined })
      if (terminal) void perform('launch')
      return
    }
    if (id === 'zcode' && panel !== 'quit') { update({ panel: 'quit', error: undefined }); return }
    void perform('connect')
  }
  const label = panel === 'quit' ? t('common.saveChanges') : saved
    ? t(terminal ? 'agents.connect.launch' : follow ? 'agents.connect.finish' : 'agents.connect.saved')
    : t('agents.connect.button')
  const Icon = saved ? follow || terminal ? CircleArrowRight : Check : Plug
  const errors: Record<SetupError, string> = {
    gateway: 'keys.outlookUnavailable', catalog: 'models.noModelsBefore', config: 'agents.connect.writeError',
    permission: 'agents.connect.writeError', missing: 'agents.connect.missing', terminal: 'keys.testFailedShort',
  }
  return <article className="agent" data-agent={id}>
    <div className="tilebody">
      <div className="idline"><AgentIcon id={id} name={name} /><span className="route">{surfaces[id] ?? 'Terminal'}</span></div>
      <div className="tilecopy"><h3>{name}</h3><p>{t('agents.descriptions.' + id)}</p></div>
      <div className="tileactions">
        <button className="connect" disabled={busy} data-state={saved ? follow ? 'follow' : 'ready' : 'initial'}
          aria-label={label + ' · ' + name} onClick={connect}><Icon />{busy ? t('common.loading') : label}</button>
        <button className="more" disabled={busy} aria-label={t('agents.connect.details') + ' · ' + name}
          aria-expanded={panel === 'details'} onClick={() => { activate(); if (panel === 'details') update({ panel: null, error: undefined }); else void perform('details') }}><Ellipsis /></button>
      </div>
    </div>
    {(panel || error) && <section className="detail" aria-live="polite">
      {error && <div role="alert"><h4>{error === 'gateway' ? t('agents.connect.gateway') + ' · ' : error === 'terminal' ? t('agents.connect.launch') + ' · ' : ''}{t(errors[error])}{error === 'catalog' && t('models.keysPageLink') + t('models.noModelsAfter')}</h4>{docs}</div>}
      {panel === 'details' && <>
        <h4>{t('agents.connect.details')}</h4><p>{t(tool.configType === 'guide' ? 'agents.manualHint' : 'agents.description')}</p>
        {seen && <p>{t('agents.seenRecently')}</p>}
        {(id === 'claude' || id === 'codex') && <p>{t(id === 'claude' ? 'search.agentsBadgeClaude' : 'search.agentsBadgeCodex')}</p>}
        <Files files={paths ?? []} />
        <code className="value">npx freellmapi {tool.command} --url {origin}</code>
        {saved && <button className="subbutton" disabled={busy} onClick={connect}>{t('common.apply')}</button>} {docs}
      </>}
      {panel === 'quit' && <p>{t('agents.connect.quit')}</p>}
      {panel === 'guide' && <>
        <h4>{t('agents.manualLabel')}</h4><p>{id === 'cursor' ? t('agents.connect.cursor') : t('agents.manualHint')}</p>
        {id === 'cursor' && <code>Cursor Settings → Models → Override OpenAI Base URL</code>}
        <span className="minor">{t('agents.endpoint')}</span><code className="value">{id === 'cursor' ? 'https://<public-gateway>/v1' : origin + '/v1'}</code>
        <span className="minor">{t('agents.apiKey')}</span><GatewayKey />
        {id === 'generic' && <><span className="minor">{t('common.model')}</span><code className="value">auto</code></>}
        {docs}
      </>}
      {panel === 'saved' && saved && <>
        <h4>{t('agents.connect.saved')}</h4>
        {terminal ? <>
          <button className="subbutton mt-2" disabled={busy} onClick={() => void perform('launch')}><Terminal /> {t('agents.connect.launch')}</button>
          {state.launched && !error && <span className="minor">{t('common.success')}</span>}
          <details><summary>{t('agents.manualLabel')}</summary><GatewayKey command={id} /></details>
        </> : id === 'roo' ? <><p>Roo Settings → Import</p><code className="value">{saved[0]?.path}</code></>
          : <p>{t(restart ? 'agents.connect.restart' : 'agents.connect.send', { name })}</p>}
        <details><summary>{t('agents.connect.files')}</summary><Files files={saved} /></details>
      </>}
    </section>}
  </article>
}

export function DesktopAgentsPage({ bridge }: { bridge: AgentSetupBridge }) {
  const { t } = useI18n()
  const seen = useRecentAgents()
  const [active, setActive] = useState<string>()
  const [query, setQuery] = useState('')
  const [gateway, setGateway] = useState(false)
  const [states, setStates] = useState<Record<string, CardState>>({})
  const search = query.trim().toLowerCase()
  const visible = search ? tools.filter(tool => (tool.name + ' ' + tool.id).toLowerCase().includes(search)) : tools
  return <div id="agent-connect-screen">
    <header className="heading"><div><h1>{t('agents.title')}</h1><p>{t('agents.connect.intro')}</p></div>
      <button className="gateway-btn" aria-expanded={gateway} onClick={() => setGateway(!gateway)}><span className="dot" />{t('agents.connect.gateway')}<ChevronDown /></button></header>
    {gateway && <section className="gateway-box"><b>{t('agents.endpoint')}</b><code>{window.location.origin}</code><b>{t('agents.apiKey')}</b><GatewayKey /></section>}
    <div className="listbar"><h2>{t('agents.connect.all')} <span className="total">{search ? `${visible.length} / ${tools.length}` : tools.length}</span></h2>
      <label className="find"><Search /><input type="search" aria-label={t('agents.connect.find')} placeholder={t('agents.connect.find')} value={query} onChange={e => setQuery(e.target.value)} /></label></div>
    <div className="deck">{visible.map(tool => <AgentCard key={tool.id} tool={tool} bridge={bridge} active={active === tool.id} activate={() => setActive(tool.id)} seen={!!seen(tool.id)} state={states[tool.id] ?? { panel: null }}
      update={patch => setStates(old => ({ ...old, [tool.id]: { ...(old[tool.id] ?? { panel: null }), ...patch } }))} />)}</div>
    {!visible.length && <p className="empty">{t('palette.empty')}</p>}
  </div>
}
