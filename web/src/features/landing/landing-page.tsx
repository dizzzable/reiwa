import { Suspense, lazy } from 'react';
import { Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import { getLanding } from '@/lib/api-client';
import { parseLandingPayload } from './landing-schema';

const LandingRenderer = lazy(() => import('./landing-renderer'));

const LANDING_QUERY_KEY = ['landing'] as const;

/**
 * `/welcome` — the public landing page shown to unauthenticated web visitors
 * before sign-in. Fetches the effective published config through the SPA's
 * shared api-client (same cache key can be reused by the `/` entry-router to
 * decide the routing verdict from a single fetch).
 *
 * Fail-closed: on error, disabled/unpublished, or zero visible sections after
 * parsing → redirect to `/sign-in` (never render an empty page — Requirement
 * 1.4 empty-state).
 */
export default function LandingPage() {
  const { data, isLoading, isError } = useQuery({
    queryKey: LANDING_QUERY_KEY,
    queryFn: getLanding,
    staleTime: 60_000,
    retry: 1,
  });

  if (isLoading) {
    return (
      <div className="flex h-dvh items-center justify-center bg-(--brand-bg-primary)">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-(--brand-primary) border-t-transparent" />
      </div>
    );
  }

  if (isError) return <Navigate to="/sign-in" replace />;

  const parsed = parseLandingPayload(data);
  if (parsed.enabled !== true) return <Navigate to="/sign-in" replace />;
  if (parsed.sections.length === 0) return <Navigate to="/sign-in" replace />;

  return (
    <Suspense fallback={null}>
      <LandingRenderer config={parsed} />
    </Suspense>
  );
}

export { LANDING_QUERY_KEY };
