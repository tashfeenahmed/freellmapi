import { useTranslation } from 'react-i18next'
import { NavLink } from 'react-router-dom'

export function ModelsTabs() {
  const { t } = useTranslation()
  const tab = (isActive: boolean) =>
    `px-3 py-1.5 text-xs rounded-lg transition-colors ${
      isActive ? 'bg-foreground text-background font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-muted'
    }`
  return (
    <div className="inline-flex gap-1 rounded-xl border p-1">
      <NavLink to="/models/chat" className={({ isActive }) => tab(isActive)}>{t('modelsTabs.chat')}</NavLink>
      <NavLink to="/models/embeddings" className={({ isActive }) => tab(isActive)}>{t('modelsTabs.embeddings')}</NavLink>
    </div>
  )
}
