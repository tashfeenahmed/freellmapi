// Translations for the desktop's NATIVE chrome — the tray menu and the
// Control-Center popover. These live outside the React dashboard (the menu is
// built in the main process; the popover is a file:// page), so they can't read
// the dashboard's i18n. The active locale is mirrored from the dashboard via the
// `freeapi:locale-changed` IPC (preload watches <html lang>) and persisted in
// config, exactly like the theme. Keep these keys in sync with the six locales
// shipped by the client (client/src/i18n/locales).

export const NATIVE_LOCALES = ['en', 'zh-CN', 'fr', 'es', 'pt-BR', 'it'] as const;
export type NativeLocale = (typeof NATIVE_LOCALES)[number];
export const DEFAULT_NATIVE_LOCALE: NativeLocale = 'en';

// `navigator.language`-style value → closest supported locale (primary subtag).
export function normalizeLocale(raw: string | undefined | null): NativeLocale {
  const l = (raw ?? '').toLowerCase();
  if (l.startsWith('zh')) return 'zh-CN';
  if (l.startsWith('pt')) return 'pt-BR';
  if (l.startsWith('fr')) return 'fr';
  if (l.startsWith('es')) return 'es';
  if (l.startsWith('it')) return 'it';
  return 'en';
}

type Strings = Record<string, string>;

const STRINGS: Record<NativeLocale, Strings> = {
  en: {
    tooltip: 'FreeLLMAPI — local LLM router',
    runningOn: 'Running on {addr}',
    openDashboard: 'Open Dashboard',
    lanAccess: 'Allow LAN access (0.0.0.0)',
    quitApp: 'Quit FreeLLMAPI',
    running: 'running',
    requestsToday: 'Requests today',
    tokensToday: 'Tokens today',
    lastModel: 'Last model',
    copyUrl: 'Copy URL',
    copyKey: 'Copy Key',
    copied: 'Copied ✓',
    startAtLogin: 'Start at login',
    quit: 'Quit',
    hoursAgo: '24h ago',
    now: 'now',
    peak: 'peak {n}/h',
    successSuffix: '{n}% success',
  },
  'zh-CN': {
    tooltip: 'FreeLLMAPI — 本地 LLM 路由器',
    runningOn: '运行于 {addr}',
    openDashboard: '打开仪表板',
    lanAccess: '允许局域网访问 (0.0.0.0)',
    quitApp: '退出 FreeLLMAPI',
    running: '运行中',
    requestsToday: '今日请求',
    tokensToday: '今日 token',
    lastModel: '上次模型',
    copyUrl: '复制 URL',
    copyKey: '复制密钥',
    copied: '已复制 ✓',
    startAtLogin: '登录时启动',
    quit: '退出',
    hoursAgo: '24 小时前',
    now: '现在',
    peak: '峰值 {n}/小时',
    successSuffix: '{n}% 成功',
  },
  fr: {
    tooltip: 'FreeLLMAPI — routeur LLM local',
    runningOn: 'En cours sur {addr}',
    openDashboard: 'Ouvrir le tableau de bord',
    lanAccess: 'Autoriser l\'accès LAN (0.0.0.0)',
    quitApp: 'Quitter FreeLLMAPI',
    running: 'en cours',
    requestsToday: "Requêtes aujourd'hui",
    tokensToday: "Tokens aujourd'hui",
    lastModel: 'Dernier modèle',
    copyUrl: "Copier l'URL",
    copyKey: 'Copier la clé',
    copied: 'Copié ✓',
    startAtLogin: "Lancer à l'ouverture de session",
    quit: 'Quitter',
    hoursAgo: 'il y a 24 h',
    now: 'maintenant',
    peak: 'pic {n}/h',
    successSuffix: '{n} % de réussite',
  },
  es: {
    tooltip: 'FreeLLMAPI — enrutador LLM local',
    runningOn: 'En ejecución en {addr}',
    openDashboard: 'Abrir el panel',
    lanAccess: 'Permitir acceso LAN (0.0.0.0)',
    quitApp: 'Salir de FreeLLMAPI',
    running: 'en ejecución',
    requestsToday: 'Solicitudes hoy',
    tokensToday: 'Tokens hoy',
    lastModel: 'Último modelo',
    copyUrl: 'Copiar URL',
    copyKey: 'Copiar clave',
    copied: 'Copiado ✓',
    startAtLogin: 'Iniciar al arrancar sesión',
    quit: 'Salir',
    hoursAgo: 'hace 24 h',
    now: 'ahora',
    peak: 'pico {n}/h',
    successSuffix: '{n}% de aciertos',
  },
  'pt-BR': {
    tooltip: 'FreeLLMAPI — roteador LLM local',
    runningOn: 'Em execução em {addr}',
    openDashboard: 'Abrir o painel',
    lanAccess: 'Permitir acesso LAN (0.0.0.0)',
    quitApp: 'Sair do FreeLLMAPI',
    running: 'em execução',
    requestsToday: 'Solicitações hoje',
    tokensToday: 'Tokens hoje',
    lastModel: 'Último modelo',
    copyUrl: 'Copiar URL',
    copyKey: 'Copiar chave',
    copied: 'Copiado ✓',
    startAtLogin: 'Iniciar ao fazer login',
    quit: 'Sair',
    hoursAgo: '24 h atrás',
    now: 'agora',
    peak: 'pico {n}/h',
    successSuffix: '{n}% de sucesso',
  },
  it: {
    tooltip: 'FreeLLMAPI — router LLM locale',
    runningOn: 'In esecuzione su {addr}',
    openDashboard: 'Apri il pannello',
    lanAccess: 'Consenti accesso LAN (0.0.0.0)',
    quitApp: 'Esci da FreeLLMAPI',
    running: 'in esecuzione',
    requestsToday: 'Richieste oggi',
    tokensToday: 'Token oggi',
    lastModel: 'Ultimo modello',
    copyUrl: 'Copia URL',
    copyKey: 'Copia chiave',
    copied: 'Copiato ✓',
    startAtLogin: "Avvia all'accesso",
    quit: 'Esci',
    hoursAgo: '24 h fa',
    now: 'ora',
    peak: 'picco {n}/h',
    successSuffix: '{n}% di successo',
  },
};

// Translate a native key, falling back to English then the key itself.
export function dt(locale: NativeLocale, key: string, vars?: Record<string, string | number>): string {
  const raw = STRINGS[locale]?.[key] ?? STRINGS.en[key] ?? key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, name) => (name in vars ? String(vars[name]) : `{${name}}`));
}

// The full string bundle for one locale, sent to the popover in the snapshot so
// its file:// renderer (which has no access to this module) can label itself.
export function nativeStrings(locale: NativeLocale): Strings {
  return { ...STRINGS.en, ...STRINGS[locale] };
}
