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
