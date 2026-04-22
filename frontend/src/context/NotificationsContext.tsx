'use client';

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';
import api from '../api/client';

export interface NotificationItem {
  id: string;
  campaign_id: string;
  campaign_name: string;
  lead_id: string;
  company_name: string;
  sender_email: string | null;
  reply_snippet: string | null;
  replied_at: string | null;
}

interface NotificationsContextValue {
  unreadCount: number;
  items: NotificationItem[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  markRead: (ids: string[]) => Promise<void>;
  markAllRead: () => Promise<void>;
}

const NotificationsContext = createContext<NotificationsContextValue | null>(null);

// 30s polling strikes the right balance: reply-tracker runs every 15 min, so we'll
// almost always surface a new reply within the same minute it's detected, without
// hammering the API.
const POLL_INTERVAL_MS = 30_000;

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const [unreadCount, setUnreadCount] = useState(0);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const inFlightRef = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const res = await api.get('/inbox/notifications');
      const payload = res.data?.data ?? {};
      setItems(payload.items ?? []);
      setUnreadCount(payload.unreadCount ?? 0);
      setError(null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load notifications';
      setError(msg);
    } finally {
      setLoading(false);
      inFlightRef.current = false;
    }
  }, []);

  const markRead = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return;
    // Optimistic update — drop locally, then sync with server
    setItems((prev) => prev.filter((i) => !ids.includes(i.id)));
    setUnreadCount((prev) => Math.max(0, prev - ids.length));
    try {
      await api.post('/inbox/mark-replies-read', { ids });
    } catch {
      // Re-sync on failure so state doesn't drift
      refresh();
    }
  }, [refresh]);

  const markAllRead = useCallback(async () => {
    if (items.length === 0) return;
    setItems([]);
    setUnreadCount(0);
    try {
      await api.post('/inbox/mark-replies-read', {});
    } catch {
      refresh();
    }
  }, [items.length, refresh]);

  // Initial load + polling loop
  useEffect(() => {
    refresh();
    pollRef.current = setInterval(refresh, POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [refresh]);

  // Refresh on tab focus so users returning to the app don't wait up to 30s
  useEffect(() => {
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  return (
    <NotificationsContext.Provider
      value={{ unreadCount, items, loading, error, refresh, markRead, markAllRead }}
    >
      {children}
    </NotificationsContext.Provider>
  );
}

export function useNotifications(): NotificationsContextValue {
  const ctx = useContext(NotificationsContext);
  if (!ctx) throw new Error('useNotifications must be used within NotificationsProvider');
  return ctx;
}
