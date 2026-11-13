import type { Response } from 'express';

/** Aborts once the API caller hangs up before its response is fully written, so
 *  a failover chain stops instead of spending upstream calls nobody waits for.
 *  'close' also fires after a normal finish, which writableFinished tells apart. */
export function clientAbortSignal(res: Response): AbortSignal {
  const abort = new AbortController();
  res.on('close', () => { if (!res.writableFinished) abort.abort(); });
  return abort.signal;
}
