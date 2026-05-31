import { createUser, createSession } from '../../services/auth.js';

// Dashboard /api/* routes are gated by requireAuth (#35). Tests mint a session
// token once (after initDb) and attach it to gated requests.

export function mintDashboardToken(email = 'test@example.com'): string {
  const user = createUser(email, 'password123');
  return createSession(user.userId);
}

// Gated = under /api/ but not the public bootstrap routes (/api/auth/*, /api/ping).
export function isGatedApiPath(path: string): boolean {
  return path.startsWith('/api/') && !path.startsWith('/api/auth') && path !== '/api/ping';
}
