import type { NotificationItem } from '../types';
import { apiGet, apiPost } from '../lib/api';

export interface NotificationsResponse {
  notifications: NotificationItem[];
  nextCursor: string | null;
  unreadCount: number;
}

export async function listNotifications(opts?: { unreadOnly?: boolean; cursor?: string; limit?: number }): Promise<NotificationsResponse> {
  const params: Record<string, string | undefined> = {
    limit: opts?.limit === undefined ? undefined : String(opts.limit),
    cursor: opts?.cursor,
    unreadOnly: opts?.unreadOnly ? '1' : undefined,
  };
  return apiGet<NotificationsResponse>('/user/notifications', params);
}

export async function getUnreadCount(): Promise<number> {
  const data = await apiGet<{ unreadCount?: number }>('/user/notifications/unread-count');
  return data.unreadCount ?? 0;
}

export async function markNotificationRead(id: string): Promise<void> {
  await apiPost(`/user/notifications/${encodeURIComponent(id)}/read`, undefined, 'PATCH');
}

export async function markAllNotificationsRead(): Promise<{ marked: number }> {
  return apiPost<{ marked: number }>('/user/notifications/read-all', {});
}
