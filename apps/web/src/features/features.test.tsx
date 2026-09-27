import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { expectAccessible, mockFetch, renderWithProviders } from '../test/utils';
import { LoginPage } from './auth/LoginPage';
import { FileView, type ViewItem } from './files/FileView';

const items: ViewItem[] = ['Photos', 'Recipes', 'notes.txt', 'taxes.pdf'].map((name, i) => ({
  id: `id${i}`,
  name,
  type: name.includes('.') ? 'file' : 'folder',
  mimeType: name.endsWith('.pdf') ? 'application/pdf' : name.endsWith('.txt') ? 'text/plain' : null,
  thumb: 'none',
  size: 100 * i,
  updatedAt: new Date().toISOString(),
}));

describe('FileView', () => {
  it('is a keyboard-operable multi-select grid', async () => {
    const onOpen = vi.fn();
    const onDelete = vi.fn();
    const onSelection = vi.fn();
    renderWithProviders(
      <FileView
        items={items}
        view="list"
        label="Contents of My Files"
        onOpen={onOpen}
        onDelete={onDelete}
        onSelectionChange={onSelection}
        actionsFor={() => [{ id: 'open', label: 'Open', onSelect: () => {} }]}
      />,
    );
    const grid = await screen.findByRole('grid', { name: 'Contents of My Files' });
    const rows = within(grid).getAllByRole('row').slice(1); // skip header
    expect(rows).toHaveLength(4);
    // Roving tabindex: only one row is tabbable.
    expect(rows.filter((r) => r.tabIndex === 0)).toHaveLength(1);

    rows[0]!.focus();
    await userEvent.keyboard('{ArrowDown}');
    await waitFor(() => expect(rows[1]).toHaveFocus());
    await userEvent.keyboard(' ');
    expect(rows[1]).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{Shift>}{ArrowDown}{ArrowDown}{/Shift}');
    await waitFor(() => expect(rows[3]).toHaveAttribute('aria-selected', 'true'));
    expect(rows[2]).toHaveAttribute('aria-selected', 'true');
    expect(rows[0]).toHaveAttribute('aria-selected', 'false');

    await userEvent.keyboard('{Delete}');
    expect(onDelete).toHaveBeenCalledWith(['id1', 'id2', 'id3']);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(rows[1]).toHaveAttribute('aria-selected', 'false'));
    await userEvent.keyboard('{Control>}a{/Control}');
    await waitFor(() =>
      expect(rows.every((r) => r.getAttribute('aria-selected') === 'true')).toBe(true),
    );
    await userEvent.keyboard('{Enter}');
    expect(onOpen).toHaveBeenCalledWith(items[3]);
    await expectAccessible(grid);
  });

  it('sort headers announce the current order', async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <FileView
        items={items}
        view="list"
        label="Files"
        onOpen={() => {}}
        actionsFor={() => []}
        sort={{ key: 'name', dir: 'asc', onChange }}
      />,
    );
    const name = await screen.findByRole('columnheader', { name: /Name/ });
    expect(name).toHaveAttribute('aria-sort', 'ascending');
    await userEvent.click(within(name).getByRole('button'));
    expect(onChange).toHaveBeenCalledWith('name', 'desc');
  });
});

describe('LoginPage', () => {
  it('signs in with a second factor when enabled', async () => {
    const me = {
      id: 'u',
      email: 'a@x.com',
      displayName: 'A',
      role: 'member',
      quotaBytes: null,
      usedBytes: 0,
      totpEnabled: true,
      rootNodeId: 'r',
    };
    const calls = mockFetch({
      'GET /auth/setup-status': () => ({
        json: { needsSetup: false, appName: 'Kaja Family Cloud' },
      }),
      'GET /auth/me': () => ({
        status: 401,
        json: { code: 'UNAUTHENTICATED', detail: 'Please sign in' },
      }),
      'POST /auth/login': (b) =>
        (b as { password: string }).password === 'right password'
          ? { json: { status: 'mfa_required', mfaToken: 'tok' } }
          : {
              status: 401,
              json: { code: 'INVALID_CREDENTIALS', detail: 'Email or password is incorrect' },
            },
      'POST /auth/login/totp': () => ({ json: { status: 'ok', user: me } }),
    });
    const { container } = renderWithProviders(<LoginPage />, { route: '/login' });
    expect(await screen.findByText('Kaja Family Cloud')).toBeInTheDocument();
    await expectAccessible(container);

    await userEvent.type(screen.getByLabelText('Email'), 'a@x.com');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong one');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Email or password is incorrect');

    await userEvent.clear(screen.getByLabelText('Password'));
    await userEvent.type(screen.getByLabelText('Password'), 'right password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    const code = await screen.findByLabelText('Authentication code');
    const verify = screen.getByRole('button', { name: 'Verify' });
    expect(verify).toBeDisabled();
    await userEvent.type(code, '12ab3456');
    expect(code).toHaveValue('123456');
    await userEvent.click(verify);
    await waitFor(() => expect(calls.some((c) => c.path === '/auth/login/totp')).toBe(true));
    expect(calls.find((c) => c.path === '/auth/login/totp')?.body).toEqual({
      mfaToken: 'tok',
      code: '123456',
    });
  });
});
