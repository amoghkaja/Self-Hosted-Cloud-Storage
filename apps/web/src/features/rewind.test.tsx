import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { qk } from '../api/queries';
import { expectAccessible, mockFetch, renderWithProviders } from '../test/utils';
import { RewindDialog } from './files/RewindDialog';

const folder = { id: '11111111-1111-4111-8111-111111111111', name: 'Taxes' };

describe('Rewind', () => {
  it('shows what it will do, then does it', async () => {
    const calls = mockFetch({
      [`GET /nodes/${folder.id}/rewind`]: () => ({
        json: {
          restore: { count: 2, names: ['2024', 'a.txt'] },
          revert: { count: 1, names: ['b.txt'] },
          added: 1,
        },
      }),
      [`POST /nodes/${folder.id}/rewind`]: () => ({ json: { restored: 2, reverted: 1, added: 1 } }),
    });
    const onClose = vi.fn();
    renderWithProviders(<RewindDialog folder={folder} onClose={onClose} />);
    const dialog = await screen.findByRole('dialog', { name: 'Rewind “Taxes”' });
    expect(
      await within(dialog).findByText(/Puts back 2 deleted items: “2024”, “a.txt”/),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(/Gives 1 file back what it held then: “b.txt”/),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/1 file added since then stays/)).toBeInTheDocument();
    await expectAccessible(dialog);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Rewind' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const post = calls.find((c) => c.method === 'POST');
    const at = Date.parse((post!.body as { at: string }).at);
    // "An hour ago" by default.
    expect(Math.abs(Date.now() - 3600_000 - at)).toBeLessThan(60_000);
  });

  it('refreshes every view that can show what came back', async () => {
    mockFetch({
      [`GET /nodes/${folder.id}/rewind`]: () => ({
        json: {
          restore: { count: 1, names: ['beach.jpg'] },
          revert: { count: 0, names: [] },
          added: 0,
        },
      }),
      [`POST /nodes/${folder.id}/rewind`]: () => ({ json: { restored: 1, reverted: 0, added: 0 } }),
    });
    const onClose = vi.fn();
    const { qc } = renderWithProviders(<RewindDialog folder={folder} onClose={onClose} />);
    const views = [qk.recent, qk.starred, qk.sharedByMe, qk.albumList(null), qk.trash];
    for (const key of views) qc.setQueryData(key, { items: [] });
    const dialog = await screen.findByRole('dialog', { name: 'Rewind “Taxes”' });
    await within(dialog).findByText(/Puts back 1 deleted item/);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Rewind' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(views.map((key) => qc.getQueryState(key)?.isInvalidated)).toEqual(views.map(() => true));
  });

  it('says when there is nothing to put back', async () => {
    mockFetch({
      [`GET /nodes/${folder.id}/rewind`]: () => ({
        json: { restore: { count: 0, names: [] }, revert: { count: 0, names: [] }, added: 3 },
      }),
    });
    renderWithProviders(<RewindDialog folder={folder} onClose={() => {}} />);
    expect(await screen.findByText(/Nothing was deleted or saved over/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rewind' })).toBeDisabled();
  });
});
