import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { mockFetch } from '../test/utils';
import { qk, useTrashNodes, useUpdateNode } from './queries';

const albumId = '44444444-4444-4444-8444-444444444444';
const tripFolder = '22222222-2222-4222-8222-222222222222';
const photo = '11111111-1111-4111-8111-111111111111';

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The album was open a moment ago: its photos and the trip list are cached and still fresh.
  qc.setQueryData(qk.albumPhotos(albumId), { pages: [], pageParams: [] });
  qc.setQueryData(qk.albumList(null), { items: [] });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const stale = () =>
    [qk.albumPhotos(albumId), qk.albumList(null)].map(
      (key) => qc.getQueryState(key)?.isInvalidated,
    );
  return { qc, wrapper, stale };
}

describe('changes to files refresh the family albums they may be in', () => {
  it('moving a trip photo to the trash', async () => {
    mockFetch({ [`DELETE /nodes/${photo}`]: () => ({ json: {} }) });
    const { wrapper, stale } = setup();
    const { result } = renderHook(() => useTrashNodes(), { wrapper });
    await act(() => result.current.mutateAsync({ items: [{ id: photo, parentId: tripFolder }] }));
    expect(stale()).toEqual([true, true]);
  });

  it('renaming or moving a trip photo', async () => {
    mockFetch({ [`PATCH /nodes/${photo}`]: () => ({ json: {} }) });
    const { wrapper, stale } = setup();
    const { result } = renderHook(() => useUpdateNode(), { wrapper });
    await act(() =>
      result.current.mutateAsync({ id: photo, name: 'Beach.jpg', fromParentId: tripFolder }),
    );
    expect(stale()).toEqual([true, true]);
  });
});
