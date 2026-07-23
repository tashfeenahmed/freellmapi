import { describe, expect, it } from 'vitest'
import { getToasts, toast } from './toast'

const READABLE_INFO_DURATION_MS = 10_000
const READABLE_ERROR_DURATION_MS = 12_000

describe('toast defaults', () => {
  it('keeps non-error notifications visible long enough to read', () => {
    const id = toast.success('Saved settings')
    const item = getToasts().find(t => t.id === id)

    expect(item?.duration).toBe(READABLE_INFO_DURATION_MS)
  })

  it('keeps error notifications visible longer than status updates', () => {
    const id = toast.error('Provider request failed after the upstream stream stalled')
    const item = getToasts().find(t => t.id === id)

    expect(item?.duration).toBe(READABLE_ERROR_DURATION_MS)
  })
})
