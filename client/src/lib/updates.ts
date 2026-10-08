/** Fired to open the Updates dialog from anywhere (the ⋯ menu, the update pill). */
export const OPEN_UPDATES_EVENT = 'freellmapi:open-updates'

export function openUpdates(): void {
  window.dispatchEvent(new Event(OPEN_UPDATES_EVENT))
}

export const RELEASES_URL = 'https://github.com/tashfeenahmed/freellmapi/releases/latest'
