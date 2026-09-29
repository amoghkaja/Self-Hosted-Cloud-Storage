import type { FileNode, VersionList } from '@familycloud/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { expectAccessible, mockFetch, renderWithProviders } from '../test/utils';
import { VersionsDialog } from './files/VersionsDialog';
import { ReplaceDialog } from './uploads/ReplaceDialog';

const file: FileNode = {
  id: '11111111-1111-4111-8111-111111111111',
  type: 'file',
  name: 'budget.xlsx',
  size: 500,
  mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  parentId: '22222222-2222-4222-8222-222222222222',
  ownerId: '33333333-3333-4333-8333-333333333333',
  thumb: 'none',
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-20T10:00:00.000Z',
};

const list = (canDelete: boolean): VersionList => ({
  current: {
    size: 500,
    modifiedAt: '2026-09-20T10:00:00.000Z',
    modifiedBy: { id: 'u2', displayName: 'Dad' },
  },
  items: [
    {
      id: '44444444-4444-4444-8444-444444444444',
      size: 300,
      mimeType: null,
      modifiedAt: '2026-09-10T08:00:00.000Z',
      modifiedBy: { id: 'u1', displayName: 'Mum' },
      replacedAt: '2026-09-20T10:00:00.000Z',
    },
  ],
  retentionDays: 30,
  canDelete,
});

describe('Version history', () => {
  it('lists versions with who saved them, and restores one', async () => {
    const calls = mockFetch({
      [`GET /nodes/${file.id}/versions`]: () => ({ json: list(true) }),
      [`POST /nodes/${file.id}/versions/44444444-4444-4444-8444-444444444444/restore`]: () => ({
        json: { node: file },
      }),
    });
    renderWithProviders(<VersionsDialog node={file} onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog', { name: /Version history/ });
    expect(await within(dialog).findByText(/saved by Dad/)).toBeInTheDocument();
    expect(within(dialog).getByText(/saved by Mum/)).toBeInTheDocument();
    expect(within(dialog).getByText(/kept for 30 days/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: /^Restore the version/ }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/restore'))).toBe(true),
    );
    // Only the owner gets delete buttons.
    expect(within(dialog).getByRole('button', { name: /^Delete the version/ })).toBeInTheDocument();
    await expectAccessible(dialog);
  });

  it('hides delete from people who can only edit', async () => {
    mockFetch({ [`GET /nodes/${file.id}/versions`]: () => ({ json: list(false) }) });
    renderWithProviders(<VersionsDialog node={file} onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText(/saved by Mum/);
    expect(within(dialog).queryByRole('button', { name: /^Delete/ })).toBeNull();
  });
});

describe('Replace or keep both', () => {
  it('explains both choices and reports the one picked', async () => {
    const onChoose = vi.fn();
    renderWithProviders(
      <ReplaceDialog
        names={['a.txt', 'b.txt']}
        folderName="Taxes"
        retentionDays={30}
        onChoose={onChoose}
        onCancel={() => {}}
      />,
    );
    const dialog = await screen.findByRole('dialog', { name: '2 files are already here' });
    expect(within(dialog).getByText(/stays in Version history for 30 days/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep both' }));
    expect(onChoose).toHaveBeenLastCalledWith(false);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Replace' }));
    expect(onChoose).toHaveBeenLastCalledWith(true);
    await expectAccessible(dialog);
  });

  it('warns that replacing deletes the old file when versions are off', async () => {
    renderWithProviders(
      <ReplaceDialog
        names={['a.txt']}
        folderName="Taxes"
        retentionDays={0}
        onChoose={() => {}}
        onCancel={() => {}}
      />,
    );
    const dialog = await screen.findByRole('dialog', { name: '“a.txt” is already here' });
    expect(within(dialog).getByText(/deletes what's there now for good/)).toBeInTheDocument();
  });
});
