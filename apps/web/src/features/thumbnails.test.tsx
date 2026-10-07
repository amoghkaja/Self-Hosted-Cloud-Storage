import type { Album, FileNode, Me, TrashItem } from '@familycloud/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { contentUrl, thumbUrl } from '../api/client';
import { qk } from '../api/queries';
import { TooltipProvider } from '../components/ui';
import { mockFetch } from '../test/utils';
import { RecentPage, TrashPage } from './files/OtherViews';
import PreviewModal from './files/PreviewModal';
import { coverUrl } from './photos/PhotosPage';

const me = {
  id: '33333333-3333-4333-8333-333333333333',
  displayName: 'Mum',
  rootNodeId: '22222222-2222-4222-8222-222222222222',
} as Me;

const photo = (updatedAt: string): FileNode => ({
  id: '11111111-1111-4111-8111-111111111111',
  type: 'file',
  name: 'beach.jpg',
  size: 1000,
  mimeType: 'image/jpeg',
  parentId: me.rootNodeId,
  ownerId: me.id,
  thumb: 'ready',
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt,
});

// Thumbnails are cached by the browser for good, so a photo saved over (Replace, a restored
// version, Rewind) must get a new thumbnail address, or the old picture stays on screen.
describe('thumbnails after a file is saved over', () => {
  it('change address in the file list', async () => {
    let current = photo('2026-09-20T10:00:00.000Z');
    mockFetch({
      'GET /recent': () => ({ json: { items: [current] } }),
      'GET /starred': () => ({ json: { items: [] } }),
      'GET /users/directory': () => ({ json: { items: [] } }),
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createMemoryRouter(
      [
        {
          path: '/',
          element: <Outlet context={{ me }} />,
          children: [{ path: 'recent', element: <RecentPage /> }],
        },
      ],
      { initialEntries: ['/recent'] },
    );
    const { container } = render(
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    await screen.findByRole('row', { name: /beach\.jpg/ });
    const before = container.querySelector('img')?.getAttribute('src');
    expect(before).toContain(`/nodes/${current.id}/thumbnail`);

    current = photo('2026-10-07T08:00:00.000Z');
    await qc.invalidateQueries({ queryKey: qk.recent });
    await waitFor(() =>
      expect(container.querySelector('img')?.getAttribute('src')).not.toBe(before),
    );
  });

  it('change address in the photo viewer', () => {
    const view = (p: FileNode) =>
      render(
        <PreviewModal
          items={[p]}
          index={0}
          onIndexChange={() => {}}
          onClose={() => {}}
          source={{ content: contentUrl, thumb: thumbUrl, canDownload: true }}
        />,
      );
    const src = () => screen.getByRole('img', { name: 'beach.jpg' }).getAttribute('src');
    const first = view(photo('2026-09-20T10:00:00.000Z'));
    const before = src();
    first.unmount();
    view(photo('2026-10-07T08:00:00.000Z'));
    expect(src()).not.toBe(before);
  });

  it('change address for an album cover', () => {
    const album = (updatedAt: string) =>
      ({
        id: '44444444-4444-4444-8444-444444444444',
        cover: { nodeId: photo(updatedAt).id, thumb: 'ready', updatedAt },
      }) as Album;
    expect(coverUrl(album('2026-09-20T10:00:00.000Z'))).not.toBe(
      coverUrl(album('2026-10-07T08:00:00.000Z')),
    );
  });

  it('change address each time a file goes to the trash', async () => {
    const trashed = (deletedAt: string): TrashItem => ({
      id: photo('x').id,
      type: 'file',
      name: 'beach.jpg',
      size: 1000,
      mimeType: 'image/jpeg',
      thumb: 'ready',
      deletedAt,
      originalParent: null,
    });
    let current = trashed('2026-09-20T10:00:00.000Z');
    mockFetch({ 'GET /trash': () => ({ json: { items: [current], retentionDays: 30 } }) });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createMemoryRouter(
      [
        {
          path: '/',
          element: <Outlet context={{ me }} />,
          children: [{ path: 'trash', element: <TrashPage /> }],
        },
      ],
      { initialEntries: ['/trash'] },
    );
    const { container } = render(
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    await screen.findByText('beach.jpg');
    const before = container.querySelector('img')?.getAttribute('src');
    expect(before).toContain(`/nodes/${current.id}/thumbnail`);
    // Restored, saved over and trashed again: its contents may have changed in between.
    current = trashed('2026-10-07T08:00:00.000Z');
    await qc.invalidateQueries({ queryKey: qk.trash });
    await waitFor(() =>
      expect(container.querySelector('img')?.getAttribute('src')).not.toBe(before),
    );
  });
});
