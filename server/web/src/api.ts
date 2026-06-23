import type { WebUser, WebSessionMeta, SessionDetail, ReleaseItem, FeedbackItem } from './types';

async function apiFetch(url: string, options?: RequestInit): Promise<Response> {
  const res = await fetch(url, options);
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    const err = new Error(text || `HTTP ${res.status}`);
    (err as Error & { status: number }).status = res.status;
    throw err;
  }
  return res;
}

export async function getMe(): Promise<WebUser> {
  return apiFetch('/api/auth/me').then(r => r.json());
}

export async function listSessions(): Promise<{ items: WebSessionMeta[] }> {
  return apiFetch('/api/sessions').then(r => r.json());
}

export async function getSession(id: string): Promise<SessionDetail> {
  return apiFetch(`/api/sessions/${id}`).then(r => r.json());
}

export async function deleteSession(id: string): Promise<void> {
  await apiFetch(`/api/sessions/${id}`, { method: 'DELETE' });
}

export async function importSessions(_employeeId: string, _startDate: string, _endDate: string): Promise<void> {
  await apiFetch('/api/sessions/import', { method: 'POST' });
}

export async function listReleases(): Promise<{ items: ReleaseItem[] }> {
  return apiFetch('/api/releases').then(r => r.json());
}

export async function getAdminFeedback(params?: { status?: string; limit?: number; offset?: number }): Promise<{ items: FeedbackItem[] }> {
  const q = new URLSearchParams();
  if (params?.status) q.set('status', params.status);
  if (params?.limit != null) q.set('limit', String(params.limit));
  if (params?.offset != null) q.set('offset', String(params.offset));
  const qs = q.toString();
  return apiFetch(`/api/admin/feedback${qs ? '?' + qs : ''}`).then(r => r.json());
}

export async function patchAdminFeedback(id: string, body: { status?: string; admin_note?: string }): Promise<void> {
  await apiFetch(`/api/admin/feedback/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function publishRelease(version: string, artifact: File, signature: File): Promise<void> {
  const fd = new FormData();
  fd.append('version', version);
  fd.append('artifact', artifact);
  fd.append('signature', signature);
  await apiFetch('/api/admin/releases', { method: 'POST', body: fd });
}
