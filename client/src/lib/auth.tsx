import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from './api';

export type AuthUser = { id: number; username: string; role: string };
export type AuthStatusResponse = { setupRequired: boolean; authenticated: boolean };
export type MeResponse = { user: AuthUser | null };

const authKey = { root: ['auth'] as const, status: () => [...authKey.root, 'status'] as const, me: () => [...authKey.root, 'me'] as const };

export function useAuthStatus() {
  return useQuery({
    queryKey: authKey.status(),
    queryFn: () => apiFetch<AuthStatusResponse>('/api/auth/status'),
    staleTime: 10_000,
  });
}

export function useMe() {
  return useQuery({
    queryKey: authKey.me(),
    queryFn: () => apiFetch<MeResponse>('/api/auth/me'),
    staleTime: 30_000,
  });
}

async function postAuthJson<T>(url: string, body: object): Promise<T> {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  const r = await fetch(`${base}${url}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error((data as { error?: { message?: string } }).error?.message ?? `HTTP ${r.status}`);
  }
  return data as T;
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { username: string; password: string }) =>
      postAuthJson<{ user: AuthUser }>('/api/auth/login', vars),
    onSuccess: (data) => {
      // Write session to cache; do not invalidate immediately (refetch can run before the browser applies Set-Cookie from the login response and overwrite with `{ user: null }`).
      queryClient.setQueryData<MeResponse>(authKey.me(), { user: data.user });
      queryClient.setQueryData<AuthStatusResponse>(authKey.status(), {
        setupRequired: false,
        authenticated: true,
      });
    },
  });
}

export function useSetup() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: (vars: { username: string; password: string; confirmPassword: string }) =>
      postAuthJson<{ user: AuthUser }>('/api/auth/setup', vars),
    onSuccess: (data) => {
      queryClient.setQueryData<MeResponse>(authKey.me(), { user: data.user });
      queryClient.setQueryData<AuthStatusResponse>(authKey.status(), {
        setupRequired: false,
        authenticated: true,
      });
      navigate('/playground', { replace: true });
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: () => apiFetch<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
    onSuccess: () => {
      queryClient.setQueryData<MeResponse>(authKey.me(), { user: null });
      const status = queryClient.getQueryData<AuthStatusResponse>(authKey.status());
      queryClient.setQueryData<AuthStatusResponse>(authKey.status(), {
        setupRequired: status?.setupRequired ?? false,
        authenticated: false,
      });
      void queryClient.invalidateQueries({ queryKey: authKey.root });
      navigate('/login', { replace: true });
    },
  });
}
