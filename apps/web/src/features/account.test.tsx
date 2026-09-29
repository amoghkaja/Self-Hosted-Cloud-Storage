import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { expectAccessible, mockFetch, renderWithProviders } from '../test/utils';
import { ResetPasswordPage } from './auth/ResetPasswordPage';

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
});
