import { describe, expect, it, vi } from 'vitest'

// The toast store keeps module-level state, so each test gets a fresh copy of
// the module instead of sharing one mutable list across tests.
async function loadStore() {
  vi.resetModules()
  return await import('./toast')
}

describe('toast store (#586)', () => {
  describe('per-severity default durations', () => {
    it('gives success and info toasts 5000ms', async () => {
      const { toast, getToasts } = await loadStore()
      toast.success('saved')
      toast.info('heads up')
      expect(getToasts().map(t => t.duration)).toEqual([5000, 5000])
    })

    it('makes errors sticky (duration null, no auto-dismiss)', async () => {
      const { toast, getToasts } = await loadStore()
      toast.error('boom')
      expect(getToasts()[0].duration).toBeNull()
    })

    it('lets an explicit per-call duration win, including for errors', async () => {
      const { toast, getToasts } = await loadStore()
      toast.error('transient', 2000)
      toast.success('slow read', 10000)
      expect(getToasts().map(t => t.duration)).toEqual([2000, 10000])
    })
  })

  it('replaces an identical pending toast instead of stacking duplicates', async () => {
    const { toast, getToasts } = await loadStore()
    toast.error('poll failed')
    toast.error('poll failed')
    expect(getToasts()).toHaveLength(1)
    // Same kind but different message, or same message but different kind,
    // must still stack.
    toast.info('poll failed')
    toast.error('other failure')
    expect(getToasts()).toHaveLength(3)
  })

  it('dismissToast removes a toast and ignores unknown ids', async () => {
    const { toast, dismissToast, getToasts } = await loadStore()
    const id = toast.error('boom')
    dismissToast(999)
    expect(getToasts()).toHaveLength(1)
    dismissToast(id)
    expect(getToasts()).toHaveLength(0)
  })

  describe('cap eviction', () => {
    it('caps the stack at 4', async () => {
      const { toast, getToasts } = await loadStore()
      for (let i = 0; i < 6; i++) toast.info(`msg ${i}`)
      expect(getToasts()).toHaveLength(4)
      expect(getToasts().map(t => t.message)).toEqual(['msg 2', 'msg 3', 'msg 4', 'msg 5'])
    })

    it('never evicts an un-dismissed error while non-errors are present', async () => {
      const { toast, getToasts } = await loadStore()
      toast.error('important error') // oldest — the old slice(-4) would drop it
      toast.info('a')
      toast.success('b')
      toast.info('c')
      toast.info('d')
      const kept = getToasts()
      expect(kept).toHaveLength(4)
      expect(kept.map(t => t.message)).toEqual(['important error', 'b', 'c', 'd'])
    })

    it('keeps evicting oldest non-errors as errors accumulate', async () => {
      const { toast, getToasts } = await loadStore()
      toast.info('a')
      toast.error('e1')
      toast.info('b')
      toast.error('e2')
      toast.error('e3')
      toast.error('e4')
      expect(getToasts().map(t => t.message)).toEqual(['e1', 'e2', 'e3', 'e4'])
    })

    it('evicts the oldest error only when the stack is all errors', async () => {
      const { toast, getToasts } = await loadStore()
      for (let i = 0; i < 5; i++) toast.error(`err ${i}`)
      expect(getToasts().map(t => t.message)).toEqual(['err 1', 'err 2', 'err 3', 'err 4'])
    })
  })
})
