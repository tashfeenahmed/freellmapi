import type { Request, Response, NextFunction } from 'express';

export function errorHandler(err: Error, _req: Request, res: Response, next: NextFunction) {
  const isProduction = (process.env.NODE_ENV ?? 'development') === 'production';
  console.error('[Error]', isProduction ? err : err.message);

  if (res.headersSent) return next(err);

  const status = (err as any).status ?? 500;
  const message = isProduction && status >= 500
    ? 'Internal server error'
    : err.message;
  res.status(status).json({
    error: {
      message,
      type: err.name ?? 'server_error',
    },
  });
}
