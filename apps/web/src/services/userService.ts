import type { CurrentUser } from '../types';
import { apiGet, apiPatch } from '../lib/api';

export async function loadCurrentUser(): Promise<CurrentUser> {
  return apiGet<CurrentUser>('/user/me');
}

export async function renameCurrentUsername(username: string): Promise<CurrentUser> {
  return apiPatch<CurrentUser>('/user/me/username', { username });
}
