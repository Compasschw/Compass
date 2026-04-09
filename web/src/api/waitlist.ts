import { api } from './client';

export interface WaitlistEntry {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  role: string;
  created_at: string;
}

export async function submitWaitlist(data: {
  first_name: string;
  last_name: string;
  email: string;
  role: string;
}): Promise<WaitlistEntry> {
  return api<WaitlistEntry>('/waitlist/', {
    method: 'POST',
    body: JSON.stringify(data),
    skipAuth: true,
  });
}

export async function fetchWaitlistEntries(): Promise<WaitlistEntry[]> {
  return api<WaitlistEntry[]>('/waitlist/', { skipAuth: true });
}

export async function fetchWaitlistCount(): Promise<number> {
  const res = await api<{ count: number }>('/waitlist/count', { skipAuth: true });
  return res.count;
}
