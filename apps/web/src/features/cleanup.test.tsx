import type { CleanupFile, CleanupReport } from '@familycloud/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { expectAccessible, mockFetch, renderWithProviders } from '../test/utils';
import { FreeUpSpacePage } from './storage/FreeUpSpacePage';

const file = (id: string, name: string, size: number, folder: string): CleanupFile => ({
  id: `00000000-0000-4000-8000-${id.padStart(12, '0')}`,
  type: 'file',
  name,
  size,
  mimeType: 'image/jpeg',
  parentId: '22222222-2222-4222-8222-222222222222',
  ownerId: '33333333-3333-4333-8333-333333333333',
  thumb: 'none',
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-20T10:00:00.000Z',
  folder,
});

const film = file('1', 'film.mov', 9_000_000, 'Docs');
const a = file('2', 'IMG_1.jpg', 3_000_000, '');
const b = file('3', 'IMG_1 (from phone).jpg', 3_000_000, 'Trips / 2026-08 Goa');

const report: CleanupReport = {
  largest: [film, a],
  duplicates: [{ size: 3_000_000, count: 2, files: [a, b] }],
  versions: {
    count: 2,
    bytes: 1100,
    files: [{ file: file('4', 'budget.xlsx', 700, ''), count: 2, bytes: 1100 }],
  },
  trash: { count: 1, bytes: 400 },
};

const storage = {
  usedBytes: 15_000_000,
  versionsBytes: 1100,
  quotaBytes: null,
  availableBytes: 1e9,
};

describe('Free up space', () => {
  it('shows the biggest files, copies, versions and the trash', async () => {
    const calls = mockFetch({
      'GET /cleanup': () => ({ json: report }),
      'GET /auth/storage': () => ({ json: storage }),
      [`DELETE /nodes/${b.id}`]: () => ({ json: { ok: true } }),
      'DELETE /cleanup/versions': () => ({ json: { count: 2, bytes: 1100 } }),
    });
    renderWithProviders(<FreeUpSpacePage />);
    const biggest = await screen.findByRole('list', { name: 'Your biggest files' });
    expect(within(biggest).getByText('film.mov')).toBeInTheDocument();
    expect(within(biggest).getByText(/In Docs/)).toBeInTheDocument();
    await expectAccessible(document.body);

    await userEvent.click(screen.getByRole('tab', { name: 'Copies (1)' }));
    expect(await screen.findByText(/2 copies of IMG_1.jpg/)).toBeInTheDocument();
    expect(screen.getByText(/In Trips \/ 2026-08 Goa/)).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'Move IMG_1 (from phone).jpg to the trash' }),
    );
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'DELETE' && c.path === `/nodes/${b.id}`)).toBe(true),
    );

    await userEvent.click(screen.getByRole('tab', { name: 'Versions' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Delete all older versions' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete versions' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'DELETE' && c.path === '/cleanup/versions')).toBe(true),
    );

    await userEvent.click(screen.getByRole('tab', { name: 'Trash' }));
    expect(await screen.findByText(/1 item in the trash still takes 400 B/)).toBeInTheDocument();
  });
});
