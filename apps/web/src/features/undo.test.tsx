import type { FileNode, Me } from '@familycloud/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { Toaster, TooltipProvider } from '../components/ui';
import { mockFetch } from '../test/utils';
import { RecentPage } from './files/OtherViews';

const me: Me = {
  id: '33333333-3333-4333-8333-333333333333',
  email: 'mum@example.com',
  displayName: 'Mum',
  role: 'member',
  rootNodeId: '22222222-2222-4222-8222-222222222222',
  totpEnabled: false,
  quotaBytes: null,
  usedBytes: 0,
} as Me;

const notes: FileNode = {
  id: '11111111-1111-4111-8111-111111111111',
  type: 'file',
  name: 'notes.txt',
  size: 10,
  mimeType: 'text/plain',
  parentId: me.rootNodeId,
  ownerId: me.id,
  thumb: 'none',
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-20T10:00:00.000Z',
};

describe('Undo after moving to trash', () => {
  it('brings the item back on the page it was trashed from', async () => {
    let trashed = false;
    mockFetch({
      'GET /recent': () => ({ json: { items: trashed ? [] : [notes] } }),
      'GET /starred': () => ({ json: { items: [] } }),
      'GET /users/directory': () => ({ json: { items: [] } }),
      [`DELETE /nodes/${notes.id}`]: () => {
        trashed = true;
        return { json: {} };
      },
      [`POST /trash/${notes.id}/restore`]: () => {
        trashed = false;
        return { json: { node: notes } };
      },
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
    render(
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <RouterProvider router={router} />
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>,
    );

    const grid = await screen.findByRole('grid', { name: 'Recent files' });
    within(grid)
      .getByRole('row', { name: /notes\.txt/ })
      .focus();
    await userEvent.keyboard('{Delete}');
    expect(await screen.findByText('Nothing here yet')).toBeInTheDocument();

    // A plain click: Radix's toast swipe handling needs pointer capture, which jsdom lacks.
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    expect(await screen.findByRole('row', { name: /notes\.txt/ })).toBeInTheDocument();
  });
});
