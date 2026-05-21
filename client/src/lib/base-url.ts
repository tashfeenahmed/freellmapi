/** Vite injects BASE_URL from vite.config `base`; guard against undefined in edge builds. */
export function getAppBaseUrl(): string {
  const base = import.meta.env.BASE_URL;
  if (base == null || base === 'undefined') return '';
  return String(base).replace(/\/$/, '');
}
