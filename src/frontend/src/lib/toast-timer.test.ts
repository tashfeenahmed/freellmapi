import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startToastTimer } from './toast-timer'

describe('startToastTimer (#586)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires onExpire after the duration', () => {
    const onExpire = vi.fn()
    startToastTimer(5000, onExpire)
    vi.advanceTimersByTime(4999)
    expect(onExpire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onExpire).toHaveBeenCalledTimes(1)
  })

  it('pause suspends the countdown indefinitely', () => {
    const onExpire = vi.fn()
    const timer = startToastTimer(5000, onExpire)
    vi.advanceTimersByTime(2000)
    timer.pause()
    vi.advanceTimersByTime(60_000)
    expect(onExpire).not.toHaveBeenCalled()
  })

  it('resume continues with the remaining time, not a fresh duration', () => {
    const onExpire = vi.fn()
    const timer = startToastTimer(5000, onExpire)
    vi.advanceTimersByTime(3000)
    timer.pause()
    vi.advanceTimersByTime(60_000)
    timer.resume()
    vi.advanceTimersByTime(1999)
    expect(onExpire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onExpire).toHaveBeenCalledTimes(1)
  })

  it('overlapping holds (hover + window blur) must all release before it runs', () => {
    const onExpire = vi.fn()
    const timer = startToastTimer(5000, onExpire)
    timer.pause() // hover
    timer.pause() // blur
    timer.resume() // pointer leaves, window still blurred
    vi.advanceTimersByTime(60_000)
    expect(onExpire).not.toHaveBeenCalled()
    timer.resume() // window refocused
    vi.advanceTimersByTime(5000)
    expect(onExpire).toHaveBeenCalledTimes(1)
  })

  it('an unmatched resume (focus without a prior blur hold) does not underflow', () => {
    const onExpire = vi.fn()
    const timer = startToastTimer(5000, onExpire)
    timer.resume() // stray focus event
    timer.pause() // hover must still hold
    vi.advanceTimersByTime(60_000)
    expect(onExpire).not.toHaveBeenCalled()
  })

  it('cancel stops it for good, even after a later resume', () => {
    const onExpire = vi.fn()
    const timer = startToastTimer(5000, onExpire)
    timer.cancel()
    timer.resume()
    vi.advanceTimersByTime(60_000)
    expect(onExpire).not.toHaveBeenCalled()
  })
})
