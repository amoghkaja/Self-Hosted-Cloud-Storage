import type { Me, UpdateStatus } from '@familycloud/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { qk } from '../api/queries';
import { AppShell } from '../app/AppShell';
import { UpdateBanner } from '../app/UpdateBanner';
import { expectAccessible, mockFetch, renderWithProviders } from '../test/utils';
import { UpdatesCard } from './admin/UpdatesCard';
import { describeUpdate } from './admin/updateView';

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

function status(over: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    running: 'v0.7.0',
    updater: 'ok',
    channel: 'stable',
    checkedAt: hoursAgo(2),
    problem: null,
    available: null,
    auto: { enabled: false, nextAt: null, timezone: 'Etc/UTC' },
    pending: { check: false, install: null, auto: null },
    last: null,
    checkout: '/home/fam/familycloud',
    ...over,
  };
}
const v080 = {
  version: 'v0.8.0',
  releases: [
    {
      version: 'v0.8.0',
      date: '2026-10-10',
      groups: [{ title: 'New', items: ['**Photos:** swipe down to close a photo.'] }],
    },
  ],
  manualSteps: false,
  ready: true,
  failedBefore: false,
};
const pending = { check: false, install: null, auto: null };

describe('Updates in Admin → Overview', () => {
  it('says the server is up to date, and looks again on request', async () => {
    const calls = mockFetch({
      'GET /admin/updates': () => ({ json: status() }),
      'POST /admin/updates/check': () => ({
        json: status({ pending: { ...pending, check: true } }),
      }),
    });
    const { container } = renderWithProviders(<UpdatesCard />);
    expect(await screen.findByText(/Up to date, checked 2 hours ago/)).toBeInTheDocument();
    expect(screen.getByText(/This server runs Family Cloud v0\.7\.0/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Check now' }));
    expect(calls.some((c) => c.method === 'POST' && c.path === '/admin/updates/check')).toBe(true);
    // Busy until the helper has looked, within a minute.
    expect(await screen.findByRole('button', { name: /Check now/ })).toHaveAttribute(
      'aria-busy',
      'true',
    );
    await expectAccessible(container);
  });

  it('offers a new version with what’s new in it, and installs it', async () => {
    const calls = mockFetch({
      'GET /admin/updates': () => ({ json: status({ available: v080 }) }),
      'POST /admin/updates/install': () => ({
        json: status({ available: v080, pending: { ...pending, install: 'v0.8.0' } }),
      }),
    });
    const { container } = renderWithProviders(<UpdatesCard />);
    expect(await screen.findByText('v0.8.0 is available')).toBeInTheDocument();
    await userEvent.click(screen.getByText("What's new", { selector: 'summary' }));
    expect(screen.getByText('Photos:')).toBeVisible();
    await expectAccessible(container);

    await userEvent.click(screen.getByRole('button', { name: 'Update now' }));
    expect(calls.find((c) => c.path === '/admin/updates/install')?.body).toEqual({
      version: 'v0.8.0',
    });
    const progress = await screen.findByRole('status');
    expect(within(progress).getByText('Updating to v0.8.0')).toBeInTheDocument();
    expect(within(progress).getByText(/Waiting for the server to start it/)).toBeInTheDocument();
  });

  it('shows how an update is going, and keeps showing it while the server restarts', async () => {
    let down = false;
    const updating = status({
      available: v080,
      last: {
        state: 'updating',
        phase: 'backup',
        from: 'v0.7.0',
        to: 'v0.8.0',
        at: hoursAgo(0),
        reason: null,
        trigger: 'browser',
        log: [],
      },
    });
    mockFetch({
      'GET /admin/updates': () =>
        down ? { status: 502, json: { detail: 'Bad gateway' } } : { json: updating },
    });
    const { container, qc } = renderWithProviders(<UpdatesCard />);
    const step = await screen.findByText('Backing up the database');
    expect(step.closest('li')).toHaveAttribute('aria-current', 'step');
    expect(screen.getByText('Getting the new version').closest('li')).toHaveTextContent('(done)');
    expect(screen.queryByRole('button', { name: 'Update now' })).not.toBeInTheDocument();
    await expectAccessible(container);

    down = true;
    await act(() => qc.refetchQueries({ queryKey: qk.adminUpdates }));
    expect(
      await screen.findByText(/Restarting… This page reconnects by itself/),
    ).toBeInTheDocument();
    expect(screen.getByText('Updating to v0.8.0')).toBeInTheDocument();
  });

  it('lists what a release needs done by hand, with the command to run, and no button', async () => {
    mockFetch({
      'GET /admin/updates': () => ({
        json: status({
          available: {
            ...v080,
            manualSteps: true,
            releases: [
              {
                version: 'v0.8.0',
                date: '2026-10-10',
                groups: [
                  { title: 'New', items: ['**Photos:** swipe down to close a photo.'] },
                  { title: 'Before you update', items: ['Set `X=1` in `deploy/.env`.'] },
                ],
              },
            ],
          },
        }),
      }),
    });
    const { container } = renderWithProviders(<UpdatesCard />);
    expect(
      await screen.findByText(/It needs you to do something on the server first/),
    ).toBeVisible();
    // Listed, and in the release notes (folded away) too.
    expect(screen.getAllByText('X=1')[0]).toBeVisible();
    expect(screen.getByText('cd /home/fam/familycloud && ./scripts/update.sh')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update now' })).not.toBeInTheDocument();
    await expectAccessible(container);
  });

  it('explains an update that went back, shows what the server said, and can try again', async () => {
    mockFetch({
      'GET /admin/updates': () => ({
        json: status({
          auto: { enabled: true, nextAt: hoursAgo(-10), timezone: 'Europe/London' },
          available: { ...v080, failedBefore: true },
          last: {
            state: 'rolled-back',
            phase: null,
            from: 'v0.7.0',
            to: 'v0.8.0',
            at: hoursAgo(3),
            reason: null,
            trigger: 'auto',
            log: ['Restarting', 'The app did not become healthy within 180s.'],
          },
        }),
      }),
    });
    const { container } = renderWithProviders(<UpdatesCard />);
    expect(
      await screen.findByText(/v0\.8\.0 didn't start, so the cloud went back to v0\.7\.0/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Automatic updates won't try it again/)).toBeInTheDocument();
    await userEvent.click(screen.getByText('What the server said'));
    expect(screen.getByText(/did not become healthy within 180s/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
    await expectAccessible(container);
  });

  it('says how to set up the update helper when the server has none yet', async () => {
    mockFetch({
      'GET /admin/updates': () => ({
        json: status({ updater: 'missing', checkedAt: null, checkout: null, channel: null }),
      }),
    });
    const { container } = renderWithProviders(<UpdatesCard />);
    expect(await screen.findByText(/once on the server/)).toBeInTheDocument();
    expect(screen.getByText('./scripts/update.sh')).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    await expectAccessible(container);
  });

  it('turns automatic updates on through the helper, and says when they run', async () => {
    const calls = mockFetch({
      'GET /admin/updates': () => ({ json: status() }),
      'PUT /admin/updates/auto': () => ({ json: status({ pending: { ...pending, auto: true } }) }),
    });
    renderWithProviders(<UpdatesCard />);
    const toggle = await screen.findByRole('switch', { name: 'Install updates automatically' });
    expect(toggle).not.toBeChecked();
    await userEvent.click(toggle);
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ enabled: true });
    expect(await screen.findByText(/Saving… the server picks this up/)).toBeInTheDocument();
    expect(toggle).toBeChecked();
    expect(toggle).toBeDisabled();
  });

  it('warns when the server’s night is the middle of the day here', async () => {
    const noon = new Date();
    noon.setDate(noon.getDate() + 1);
    noon.setHours(12, 0, 0, 0);
    mockFetch({
      'GET /admin/updates': () => ({
        json: status({ auto: { enabled: true, nextAt: noon.toISOString(), timezone: 'Etc/UTC' } }),
      }),
    });
    renderWithProviders(<UpdatesCard />);
    expect(await screen.findByText(/That's during the day where you are/)).toHaveTextContent(
      'Etc/UTC',
    );
    expect(screen.getByText(/sudo timedatectl set-timezone/)).toBeInTheDocument();
  });

  it('offers to reload once the server runs a newer version than this page', async () => {
    let updated = false;
    mockFetch({
      'GET /admin/updates': () => ({
        json: updated
          ? status({
              running: 'v0.8.0',
              last: {
                state: 'done',
                phase: null,
                from: 'v0.7.0',
                to: 'v0.8.0',
                at: hoursAgo(0),
                reason: null,
                trigger: 'browser',
                log: [],
              },
            })
          : status(),
      }),
    });
    const { qc } = renderWithProviders(<UpdatesCard />);
    await screen.findByText(/Up to date/);
    expect(screen.queryByRole('button', { name: 'Reload this page' })).not.toBeInTheDocument();
    updated = true;
    await act(() => qc.refetchQueries({ queryKey: qk.adminUpdates }));
    expect(await screen.findByText(/Updated to v0\.8\.0/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload this page' })).toBeInTheDocument();
  });
});

describe('describeUpdate', () => {
  it('reports a request the helper hasn’t picked up as the helper not answering', () => {
    expect(
      describeUpdate(
        status({ updater: 'not-responding', pending: { ...pending, install: 'v0.8.0' } }),
      ).kind,
    ).toBe('not-responding');
  });

  it('leaves an old failure behind once a newer version is out', () => {
    const last = {
      state: 'failed' as const,
      phase: null,
      from: 'v0.7.0',
      to: 'v0.8.0',
      at: hoursAgo(30),
      reason: 'build' as const,
      trigger: 'auto' as const,
      log: [],
    };
    expect(describeUpdate(status({ available: v080, last })).kind).toBe('failed');
    expect(describeUpdate(status({ available: { ...v080, version: 'v0.8.1' }, last })).kind).toBe(
      'available',
    );
  });
});

describe('The update notice for admins', () => {
  beforeEach(() => localStorage.clear());
  const notice = () => screen.queryByRole('region', { name: 'Update notice' });

  it('tells about a new version until dismissed, and about the next one again', async () => {
    let version = 'v0.8.0';
    const calls = mockFetch({
      'GET /admin/updates': () => ({
        json: status({
          available: { ...v080, version },
          auto: { enabled: true, nextAt: hoursAgo(-10), timezone: 'Etc/UTC' },
        }),
      }),
    });
    const first = renderWithProviders(<UpdateBanner />);
    const shown = await screen.findByRole('region', { name: 'Update notice' });
    expect(shown).toHaveTextContent(
      'Family Cloud v0.8.0 is available. It installs itself tonight.',
    );
    expect(within(shown).getByRole('link', { name: "See what's new" })).toHaveAttribute(
      'href',
      '/admin',
    );
    await expectAccessible(first.container);
    await userEvent.click(within(shown).getByRole('button', { name: 'Dismiss' }));
    expect(notice()).not.toBeInTheDocument();
    first.unmount();

    // Still dismissed on the next visit…
    const asked = calls.length;
    const second = renderWithProviders(<UpdateBanner />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(asked));
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(notice()).not.toBeInTheDocument();
    second.unmount();

    // …until there's news.
    version = 'v0.8.1';
    renderWithProviders(<UpdateBanner />);
    expect(await screen.findByRole('region', { name: 'Update notice' })).toHaveTextContent(
      'Family Cloud v0.8.1 is available.',
    );
  });

  it('says when an update didn’t work', async () => {
    mockFetch({
      'GET /admin/updates': () => ({
        json: status({
          available: { ...v080, failedBefore: true },
          last: {
            state: 'rolled-back',
            phase: null,
            from: 'v0.7.0',
            to: 'v0.8.0',
            at: hoursAgo(1),
            reason: null,
            trigger: 'auto',
            log: [],
          },
        }),
      }),
    });
    renderWithProviders(<UpdateBanner />);
    expect(await screen.findByRole('region', { name: 'Update notice' })).toHaveTextContent(
      "Family Cloud v0.8.0 didn't start, so the cloud went back to v0.7.0. See why",
    );
  });

  it('says when a new version was installed, with what’s new in it', async () => {
    mockFetch({
      'GET /admin/updates': () => ({
        json: status({
          running: 'v0.8.0',
          last: {
            state: 'done',
            phase: null,
            from: 'v0.7.0',
            to: 'v0.8.0',
            at: hoursAgo(5),
            reason: null,
            trigger: 'auto',
            log: [],
          },
        }),
      }),
    });
    renderWithProviders(<UpdateBanner />);
    const shown = await screen.findByRole('region', { name: 'Update notice' });
    expect(shown).toHaveTextContent('Family Cloud was updated to v0.8.0.');
    expect(within(shown).getByRole('link', { name: "See what's new" })).toHaveAttribute(
      'href',
      '/whats-new',
    );
  });

  it('is for admins only: other people’s pages never ask', async () => {
    const calls = mockFetch({
      'GET /admin/updates': () => ({ json: status({ available: v080 }) }),
    });
    const person = (role: 'admin' | 'member') =>
      ({
        id: '33333333-3333-4333-8333-333333333333',
        email: 'mum@example.com',
        displayName: 'Mum',
        role,
        rootNodeId: '22222222-2222-4222-8222-222222222222',
        totpEnabled: true,
        quotaBytes: null,
        usedBytes: 0,
      }) as Me;
    const member = renderWithProviders(<AppShell me={person('member')} />);
    await screen.findByRole('main');
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(calls.some((c) => c.path === '/admin/updates')).toBe(false);
    expect(notice()).not.toBeInTheDocument();
    member.unmount();

    renderWithProviders(<AppShell me={person('admin')} />);
    expect(await screen.findByRole('region', { name: 'Update notice' })).toBeInTheDocument();
  });
});
