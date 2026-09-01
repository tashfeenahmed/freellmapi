export interface ProviderPreference {
  mode: 'automatic' | 'preferred'
  memberOrder: string[]
}

export function orderedProviderMembers<T>(
  members: readonly T[],
  preference: ProviderPreference | undefined,
  identity: (member: T) => string,
): T[] {
  if (!preference || preference.mode !== 'preferred') return [...members]
  const byId = new Map(members.map(member => [identity(member), member]))
  return [
    ...preference.memberOrder.map(id => byId.get(id)).filter((member): member is T => member !== undefined),
    ...members.filter(member => !preference.memberOrder.includes(identity(member))),
  ]
}

export function moveProviderMember<T>(members: readonly T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta
  if (index < 0 || index >= members.length || target < 0 || target >= members.length) return [...members]
  const next = [...members]
  ;[next[index], next[target]] = [next[target], next[index]]
  return next
}

/** Save the visible order without discarding temporarily absent providers.
 * Stale identities stay after visible members and resume their saved relative
 * order when catalogue/key state makes them visible again. */
export function providerOrderForSave<T>(
  visibleMembers: readonly T[],
  previousOrder: readonly string[] | undefined,
  identity: (member: T) => string,
): string[] {
  const visible = visibleMembers.map(identity)
  const visibleSet = new Set(visible)
  return [...visible, ...(previousOrder ?? []).filter(id => !visibleSet.has(id))]
}
