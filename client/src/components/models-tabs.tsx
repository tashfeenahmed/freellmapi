import { NavLink } from 'react-router-dom'
import { useI18n } from '@/i18n'

// Segmented Chat | Embeddings | Fusion switcher shared by the Models pages.
// Industry-standard layout: one "Models" section, modality as a tab — chat
// routing (cross-model fallback), embeddings routing (same-model,
// cross-provider fallback), and fusion (multi-model synthesis) are different
// machines behind one roof.
export function ModelsTabs() {
  const { t } = useI18n()
  const tab = (isActive: boolean) =>
    `inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg transition-colors ${
      isActive ? 'bg-foreground text-background font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-muted'
    }`
  return (
    <div className="inline-flex gap-1 rounded-xl border p-1">
      <NavLink to="/models/chat" className={({ isActive }) => tab(isActive)}>{t('models.chatModelsTab')}</NavLink>
      <NavLink to="/models/embeddings" className={({ isActive }) => tab(isActive)}>{t('models.embeddingsTab')}</NavLink>
      <NavLink to="/models/image" className={({ isActive }) => tab(isActive)}>{t('models.imageTab')}</NavLink>
      <NavLink to="/models/audio" className={({ isActive }) => tab(isActive)}>{t('models.audioTab')}</NavLink>
      <NavLink to="/models/fusion" className={({ isActive }) => tab(isActive)}>{t('models.fusionTab')}</NavLink>
    </div>
  )
}
