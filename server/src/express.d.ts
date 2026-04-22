import type { IronSession } from 'iron-session';
import type { SessionData } from './lib/session.js';

declare module 'express-serve-static-core' {
  interface Request {
    session: IronSession<SessionData>;
  }
}

export { };
