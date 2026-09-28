import { describe, it, expect, vi } from 'vitest';
import {
  isTransportError,
  classifyProcessError,
  handleProcessError,
  isBrokenPipeWrite,
  guardStdio,
} from '../../lib/process-safety-net.js';
import { EventEmitter } from 'node:events';
import type { SafetyNetHooks } from '../../lib/process-safety-net.js';

describe('isTransportError', () => {
  it('matches Node socket error codes', () => {
    expect(isTransportError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isTransportError(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }))).toBe(true);
    expect(isTransportError(Object.assign(new Error('x'), { code: 'EPIPE' }))).toBe(true);
  });

  it('matches undici codes nested under err.cause (the late-error shape)', () => {
    const err = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
    });
    expect(isTransportError(err)).toBe(true);
  });

  it('matches by message hint when no code is present', () => {
    expect(isTransportError(new Error('terminated'))).toBe(true);
    expect(isTransportError(new TypeError('fetch failed'))).toBe(true);
    expect(isTransportError(new Error('socket hang up'))).toBe(true);
  });

  it('does NOT match genuine programming bugs', () => {
    expect(isTransportError(new TypeError("Cannot read properties of undefined (reading 'x')"))).toBe(false);
    expect(isTransportError(Object.assign(new Error('assert'), { code: 'ERR_ASSERTION' }))).toBe(false);
    expect(isTransportError(new RangeError('Maximum call stack size exceeded'))).toBe(false);
  });

  it('handles null / undefined / cyclic causes safely', () => {
    expect(isTransportError(null)).toBe(false);
    expect(isTransportError(undefined)).toBe(false);
    const a: any = new Error('loop');
    a.cause = a; // cycle
    expect(isTransportError(a)).toBe(false);
  });
});

describe('classifyProcessError', () => {
  it('swallows transport errors and is fatal for everything else', () => {
    expect(classifyProcessError(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe('swallow');
    expect(classifyProcessError(new Error('real bug'))).toBe('fatal');
  });
});

describe('installProcessSafetyNet', () => {
  it('skips process.on registration when hasProcessHooks is false', async () => {
    vi.resetModules();
    const spy = vi.spyOn(process, 'on');
    const { installProcessSafetyNet } = await import('../../lib/process-safety-net.js');
    installProcessSafetyNet({ hasProcessHooks: false } satisfies SafetyNetHooks);
    expect(spy).not.toHaveBeenCalledWith('uncaughtException', expect.any(Function));
    expect(spy).not.toHaveBeenCalledWith('unhandledRejection', expect.any(Function));
    spy.mockRestore();
    vi.resetModules();
  });
});

describe('handleProcessError', () => {
  it('swallows a transport error without exiting', () => {
    const exit = vi.fn();
    const log = vi.fn();
    const decision = handleProcessError('uncaughtException', Object.assign(new Error('x'), { code: 'ECONNRESET' }), { exit, log });
    expect(decision).toBe('swallow');
    expect(exit).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce();
  });

  it('exits(1) on a genuine bug, preserving fail-fast', () => {
    const exit = vi.fn();
    const log = vi.fn();
    const decision = handleProcessError('unhandledRejection', new TypeError('boom'), { exit, log });
    expect(decision).toBe('fatal');
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });
});

describe('dead stdio', () => {
  const epipeWrite = () => Object.assign(new Error('write EPIPE'), { code: 'EPIPE', syscall: 'write' });

  it('swallows a broken-pipe write without logging it (logging would write to the same dead pipe)', () => {
    const log = vi.fn();
    const exit = vi.fn();
    expect(isBrokenPipeWrite(epipeWrite())).toBe(true);
    expect(handleProcessError('uncaughtException', epipeWrite(), { log, exit })).toBe('swallow');
    expect(log).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('still logs other swallowed transport errors', () => {
    const log = vi.fn();
    handleProcessError('uncaughtException', Object.assign(new Error('x'), { code: 'EPIPE', syscall: 'read' }), { log, exit: vi.fn() });
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('guardStdio drops dead-pipe stream errors and rethrows anything else', () => {
    const stream = new EventEmitter();
    guardStdio([stream]);
    expect(() => stream.emit('error', epipeWrite())).not.toThrow();
    expect(() => stream.emit('error', Object.assign(new Error('gone'), { code: 'ERR_STREAM_DESTROYED' }))).not.toThrow();
    expect(() => stream.emit('error', Object.assign(new Error('odd'), { code: 'EACCES' }))).toThrow('odd');
  });
});
