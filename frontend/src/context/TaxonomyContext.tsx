'use client';

/**
 * Taxonomy context — fetches GET /api/scrape/taxonomy once on mount and
 * exposes the result plus a refresh() that opens an EventSource against
 * /api/scrape/taxonomy/refresh and streams progress events back to the UI.
 *
 * The discovery service on the backend is single-flight so multiple tabs
 * hitting refresh at once attach to the same in-flight run.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import api from '../api/client';

export interface TaxonomyCountry {
  code: string;
  name: string;
}

export interface TaxonomyCategory {
  slug: string;
  parent_slug: string | null;
  display_name: string;
  sort_order: number;
  business_count: number | null;
  last_seen_at: string;
}

export interface RefreshProgress {
  stage: string;
  detail: string;
}

interface TaxonomyContextValue {
  countries: TaxonomyCountry[];
  categories: TaxonomyCategory[];
  lastSeenAt: string | null;
  loading: boolean;
  error: string | null;
  refreshing: boolean;
  refreshProgress: RefreshProgress | null;
  refresh: () => void;
}

const TaxonomyContext = createContext<TaxonomyContextValue | null>(null);

function buildRefreshUrl(): string {
  const base = api.defaults.baseURL ?? '/api';
  return `${base}/scrape/taxonomy/refresh`;
}

export function TaxonomyProvider({ children }: { children: ReactNode }) {
  const [countries, setCountries] = useState<TaxonomyCountry[]>([]);
  const [categories, setCategories] = useState<TaxonomyCategory[]>([]);
  const [lastSeenAt, setLastSeenAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshProgress, setRefreshProgress] = useState<RefreshProgress | null>(null);
  const sourceRef = useRef<EventSource | null>(null);

  const fetchTaxonomy = useCallback(async () => {
    try {
      // Always cache-bust — past responses carried a 5-min Cache-Control
      // header that some browsers still hold. The unique `?t=` makes the
      // request URL distinct, sidestepping every layer of HTTP cache.
      // NOTE: do NOT send Cache-Control / Pragma request headers — they
      // trigger a CORS preflight that the API server doesn't allow.
      const res = await api.get(`/scrape/taxonomy?t=${Date.now()}`);
      const data = res.data?.data ?? {};
      setCategories(Array.isArray(data.categories) ? data.categories : []);
      setCountries(Array.isArray(data.countries) ? data.countries : []);
      setLastSeenAt(typeof data.lastSeenAt === 'string' ? data.lastSeenAt : null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load taxonomy');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchTaxonomy();
  }, [fetchTaxonomy]);

  const closeStream = useCallback(() => {
    if (sourceRef.current) {
      sourceRef.current.close();
      sourceRef.current = null;
    }
  }, []);

  useEffect(() => () => closeStream(), [closeStream]);

  const refresh = useCallback(() => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshProgress({ stage: 'starting', detail: '' });

    const es = new EventSource(buildRefreshUrl());
    sourceRef.current = es;

    es.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(ev.data) as RefreshProgress;
        setRefreshProgress(parsed);
        if (parsed.stage === 'done') {
          closeStream();
          setRefreshing(false);
          void fetchTaxonomy();
        } else if (parsed.stage === 'error') {
          closeStream();
          setRefreshing(false);
          setError(parsed.detail || 'Refresh failed');
        }
      } catch {
        // Ignore malformed events
      }
    };

    es.onerror = () => {
      closeStream();
      setRefreshing(false);
      setError((prev) => prev ?? 'Refresh connection failed');
    };
  }, [refreshing, closeStream, fetchTaxonomy]);

  const value = useMemo<TaxonomyContextValue>(
    () => ({
      countries,
      categories,
      lastSeenAt,
      loading,
      error,
      refreshing,
      refreshProgress,
      refresh,
    }),
    [countries, categories, lastSeenAt, loading, error, refreshing, refreshProgress, refresh],
  );

  return <TaxonomyContext.Provider value={value}>{children}</TaxonomyContext.Provider>;
}

export function useTaxonomyContext(): TaxonomyContextValue {
  const ctx = useContext(TaxonomyContext);
  if (!ctx) throw new Error('useTaxonomyContext must be used within TaxonomyProvider');
  return ctx;
}
