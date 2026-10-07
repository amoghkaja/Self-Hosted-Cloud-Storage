import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { api } from '../api/client';
import { qk } from '../api/queries';
import { mockFetch } from '../test/utils';
import { RequireAuth } from './guards';

const me = {
  id: '33333333-3333-4333-8333-333333333333',
  email: 'mum@example.com',
  displayName: 'Mum',
  role: 'member',
  rootNodeId: '22222222-2222-4222-8222-222222222222',
  totpEnabled: false,
  quotaBytes: null,
  usedBytes: 0,
};

function Recent() {
  const recent = useQuery({ queryKey: qk.recent, queryFn: () => api('/recent') });
  return <p>{recent.isPending ? 'Loading' : 'Done'}</p>;
}

describe('RequireAuth', () => {
  it('forgets the signed-out person’s files when their session ends mid-use', async () => {
    mockFetch({
      'GET /auth/setup-status': () => ({ json: { needsSetup: false, appName: 'Family Cloud' } }),
      'GET /auth/me': () => ({ json: me }),
      // The session was revoked (signed out elsewhere, or it expired) while the tab was open.
      'GET /recent': () => ({
        status: 401,
        json: { code: 'UNAUTHENTICATED', detail: 'Please sign in' },
      }),
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // What Mum had open earlier: the next person to sign in on this tab mustn't see it.
    qc.setQueryData(qk.children(me.rootNodeId), { pages: [{ items: [], nextCursor: null }] });
    const router = createMemoryRouter(
      [
        { path: '/login', element: <p>Sign in</p> },
        { path: '/recent', element: <RequireAuth>{() => <Recent />}</RequireAuth> },
      ],
      { initialEntries: ['/recent'] },
    );
    render(
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Sign in')).toBeInTheDocument();
    expect(router.state.location.search).toBe('?next=%2Frecent');
    expect(qc.getQueryData(qk.children(me.rootNodeId))).toBeUndefined();
  });
});
