import type { Me } from '@familycloud/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { expectAccessible, mockFetch, renderWithProviders } from '../test/utils';
import { WhatsNewPage } from './about/WhatsNewPage';
import { LoginPage } from './auth/LoginPage';
import { ResetPasswordPage } from './auth/ResetPasswordPage';
import { AcceptInvitePage } from './auth/SetupPage';
import { ConnectGuide, TwoFactorSection } from './settings/SettingsPage';

describe('Password reset page', () => {
  const token = 'tok_0123456789abcdefghijklmnop';
  const page = (
    <Routes>
      <Route path="/reset/:token" element={<ResetPasswordPage />} />
    </Routes>
  );

  it('lets the person pick a new password, then sends them to sign in', async () => {
    const calls = mockFetch({
      'GET /auth/setup-status': () => ({
        json: {
          needsSetup: false,
          appName: 'Family Cloud',
          wordmark: 'Family Cloud',
          logoVersion: null,
          homeUrl: null,
          sourceUrl: 'https://example.com/src',
        },
      }),
      [`GET /password-resets/${token}`]: () => ({
        json: { email: 'mum@example.com', displayName: 'Mum', expiresAt: '2026-10-01T00:00:00Z' },
      }),
      [`POST /password-resets/${token}`]: () => ({ json: { ok: true } }),
    });
    const { container } = renderWithProviders(page, { route: `/reset/${token}` });
    expect(await screen.findByText(/For Mum \(mum@example.com\)/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('New password'), 'a long new password');
    await userEvent.type(screen.getByLabelText('Confirm new password'), 'a long new password');
    await userEvent.click(screen.getByRole('button', { name: 'Save new password' }));
    expect(await screen.findByRole('heading', { name: 'Password changed' })).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      password: 'a long new password',
    });
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
    await expectAccessible(container);
  });

  it('explains what to do when the link is used up or expired', async () => {
    mockFetch({
      [`GET /password-resets/${token}`]: () => ({
        status: 404,
        json: { code: 'RESET_INVALID', detail: 'invalid' },
      }),
    });
    renderWithProviders(page, { route: `/reset/${token}` });
    expect(await screen.findByText(/Ask your admin for a new one/)).toBeInTheDocument();
  });

  it('offers to try again instead of calling the link used up when the server is unreachable', async () => {
    let down = true;
    mockFetch({
      [`GET /password-resets/${token}`]: () =>
        down
          ? { status: 502, json: { code: 'INTERNAL_ERROR', detail: 'Request failed (502)' } }
          : {
              json: {
                email: 'mum@example.com',
                displayName: 'Mum',
                expiresAt: '2026-10-01T00:00:00Z',
              },
            },
    });
    renderWithProviders(page, { route: `/reset/${token}` });
    const retry = await screen.findByRole('button', { name: 'Try again' });
    expect(screen.queryByText(/Ask your admin for a new one/)).toBeNull();
    down = false;
    await userEvent.click(retry);
    expect(await screen.findByText(/For Mum \(mum@example.com\)/)).toBeInTheDocument();
  });
});

describe('Invite page', () => {
  const token = 'inv_0123456789abcdefghijklmnop';
  const page = (
    <Routes>
      <Route path="/invite/:token" element={<AcceptInvitePage />} />
    </Routes>
  );

  it('offers to try again instead of calling the invite used up when the server is unreachable', async () => {
    let down = true;
    mockFetch({
      [`GET /invites/${token}`]: () =>
        down
          ? { status: 503, json: { code: 'INTERNAL_ERROR', detail: 'Request failed (503)' } }
          : {
              json: {
                email: null,
                role: 'member',
                invitedBy: 'Dad',
                expiresAt: '2026-10-01T00:00:00Z',
              },
            },
    });
    renderWithProviders(page, { route: `/invite/${token}` });
    const retry = await screen.findByRole('button', { name: 'Try again' });
    expect(screen.queryByText(/already been used/)).toBeNull();
    down = false;
    await userEvent.click(retry);
    expect(await screen.findByText(/Dad invited you/)).toBeInTheDocument();
  });

  it('still says a used or expired invite can’t be used', async () => {
    mockFetch({
      [`GET /invites/${token}`]: () => ({
        status: 404,
        json: { code: 'NOT_FOUND', detail: 'Invite not found' },
      }),
    });
    renderWithProviders(page, { route: `/invite/${token}` });
    expect(await screen.findByText(/already been used/)).toBeInTheDocument();
  });
});

describe('Two-factor setup', () => {
  it('can be done on the phone that has the authenticator app: no code to scan needed', async () => {
    const otpauthUrl =
      'otpauth://totp/Family%20Cloud:mum%40example.com?secret=ABCDEF234567&issuer=Family%20Cloud';
    mockFetch({
      'POST /auth/totp/setup': (b) =>
        (b as { password: string }).password === 'my password'
          ? { json: { secret: 'ABCDEF234567', otpauthUrl } }
          : { status: 400, json: { code: 'INVALID_CREDENTIALS', detail: 'Password is incorrect' } },
    });
    const me: Me = {
      id: 'u',
      email: 'mum@example.com',
      displayName: 'Mum',
      role: 'member',
      quotaBytes: null,
      usedBytes: 0,
      totpEnabled: false,
      rootNodeId: 'r',
    };
    const { baseElement } = renderWithProviders(<TwoFactorSection me={me} />);
    await userEvent.click(screen.getByRole('button', { name: 'Set up two-factor' }));
    // Confirm it's you first: a stolen session alone can't put someone else's app on the account.
    const dialog = await screen.findByRole('dialog', { name: 'Set up two-factor' });
    await userEvent.type(within(dialog).getByLabelText('Your password'), 'wrong');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(await within(dialog).findByText('Password is incorrect')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Your password')).toHaveAttribute('aria-invalid', 'true');
    await expectAccessible(baseElement);
    await userEvent.clear(within(dialog).getByLabelText('Your password'));
    await userEvent.type(within(dialog).getByLabelText('Your password'), 'my password');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(
      await screen.findByRole('link', { name: 'Open in your authenticator app' }),
    ).toHaveAttribute('href', otpauthUrl);
    expect(screen.getByRole('button', { name: 'Copy key' })).toBeInTheDocument();
  });
});

describe('Sign-in with a recovery code', () => {
  it('takes a recovery code instead of the app code when the phone is lost', async () => {
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
      'GET /auth/setup-status': () => ({ json: { needsSetup: false, appName: 'Family Cloud' } }),
      'GET /auth/me': () => ({ status: 401, json: { code: 'UNAUTHENTICATED', detail: 'x' } }),
      'POST /auth/login': () => ({ json: { status: 'mfa_required', mfaToken: 'tok' } }),
      'POST /auth/login/recovery': () => ({ json: { status: 'ok', user: me } }),
    });
    renderWithProviders(<LoginPage />, { route: '/login' });
    await userEvent.type(await screen.findByLabelText('Email'), 'a@x.com');
    await userEvent.type(screen.getByLabelText('Password'), 'right password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await userEvent.click(
      await screen.findByRole('button', { name: 'Lost your phone? Use a recovery code' }),
    );
    await userEvent.type(screen.getByLabelText('Recovery code'), 'abcde-fghjk');
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/auth/login/recovery')?.body).toEqual({
        mfaToken: 'tok',
        code: 'abcde-fghjk',
      }),
    );
  });
});

describe('Network drive setup', () => {
  const creds = {
    appPassword: { id: 'p', name: 'Laptop', createdAt: '2026-10-01T00:00:00Z', lastUsedAt: null },
    password: 'abcde-fghij-klmno-pqrst',
    davUrl: 'https://cloud.example.com/dav/',
    username: 'mum@example.com',
  };
  afterEach(() => vi.unstubAllGlobals());

  it('opens on the Windows steps on a Windows PC, with a ready-to-paste command', () => {
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      maxTouchPoints: 0,
    });
    renderWithProviders(<ConnectGuide creds={creds} />);
    expect(screen.getByRole('tab', { name: 'Windows' })).toHaveAttribute('aria-selected', 'true');
    expect(
      screen.getByText(
        'cmdkey /add:cloud.example.com /user:mum@example.com /pass:abcde-fghij-klmno-pqrst && net use * \\\\cloud.example.com@SSL\\dav /persistent:yes',
      ),
    ).toBeInTheDocument();
  });

  it('opens on the Mac steps elsewhere, and offers no command when the server is not https', async () => {
    renderWithProviders(
      <ConnectGuide creds={{ ...creds, davUrl: 'http://192.168.1.5:3080/dav/' }} />,
    );
    expect(screen.getByRole('tab', { name: 'Mac' })).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(screen.getByRole('tab', { name: 'Windows' }));
    expect(screen.getByText(/Map network drive/)).toBeInTheDocument();
    expect(screen.queryByText(/cmdkey/)).not.toBeInTheDocument();
  });
});

describe("What's new page", () => {
  it('shows the running version and what changed, marking the release in use', async () => {
    mockFetch({
      'GET /about': () => ({
        json: {
          version: 'v0.2.0',
          releases: [
            {
              version: 'v0.2.0',
              date: '2026-10-02',
              groups: [{ title: 'New', items: ['**Photos:** swipe down to close a photo'] }],
            },
            { version: 'v0.1.0', date: '2026-09-01', groups: [{ title: 'Fixed', items: ['x'] }] },
          ],
        },
      }),
    });
    const { container } = renderWithProviders(<WhatsNewPage />);
    expect(await screen.findByText('This server is running Family Cloud v0.2.0.')).toBeVisible();
    expect(screen.getByText('Photos:').tagName).toBe('STRONG');
    expect(screen.getAllByText("This is what you're using")).toHaveLength(1);
    await expectAccessible(container);
  });
});
