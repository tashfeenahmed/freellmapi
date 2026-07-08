import type { Request, Response, NextFunction } from 'express';

export function errorHandler(err: Error, _req: Request, res: Response, next: NextFunction) {
<<<<<<< HEAD
  console.error('[Error]', err.message);
=======
  const isProduction = (process.env.NODE_ENV ?? 'development') === 'production';
  console.error('[Error]', isProduction ? err : err.message);
>>>>>>> 6971eb3 (feat(security): harden admin endpoints and security middleware)

  if (res.headersSent) return next(err);

  const status = (err as any).status ?? 500;
<<<<<<< HEAD
  res.status(status).json({
    error: {
      message: err.message,
=======
  const message = isProduction && status >= 500
    ? 'Internal server error'
    : err.message;
  res.status(status).json({
    error: {
      message,
>>>>>>> 6971eb3 (feat(security): harden admin endpoints and security middleware)
      type: err.name ?? 'server_error',
    },
  });
}
