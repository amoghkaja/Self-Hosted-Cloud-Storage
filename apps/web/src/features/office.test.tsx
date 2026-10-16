import type { FileNode, NodeDetail, OfficeStatus } from '@familycloud/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { contentUrl, previewUrl, thumbUrl } from '../api/client';
import { expectAccessible, mockFetch, renderWithProviders } from '../test/utils';
import { OfficeCard } from './admin/OfficeCard';
import PreviewModal from './files/PreviewModal';

const GB = 1024 ** 3;
const EDITOR = 'https://office.example.com';

const doc = (name = 'letter.docx'): FileNode => ({
  id: '11111111-1111-4111-8111-111111111111',
  type: 'file',
  name,
  size: 2048,
  mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  parentId: '22222222-2222-4222-8222-222222222222',
  ownerId: '33333333-3333-4333-8333-333333333333',
  thumb: 'ready',
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-20T10:00:00.000Z',
});
const detail = (access: NodeDetail['access'], node = doc()) =>
  ({ node, access, breadcrumbs: [], isRoot: false, album: null }) as unknown as NodeDetail;

function preview(item: FileNode, editable = true) {
  return renderWithProviders(
    <PreviewModal
      items={[item]}
      index={0}
      onIndexChange={() => {}}
      onClose={() => {}}
      source={{
        content: contentUrl,
        thumb: thumbUrl,
        preview: previewUrl,
        canDownload: true,
        editable,
      }}
    />,
  );
}

beforeAll(() => {
  // jsdom can't navigate a frame; the form is the editor's way in.
  HTMLFormElement.prototype.submit = vi.fn();
});

describe('Edit in the preview', () => {
  const routes = (access: NodeDetail['access'], available = true) => ({
    'GET /office': () => ({ json: { available } }),
    'GET /nodes/11111111-1111-4111-8111-111111111111': () => ({ json: detail(access) }),
  });

  it('opens a Word file in the editor, for someone who can change it', async () => {
    const calls = mockFetch({
      ...routes('edit'),
      'POST /nodes/11111111-1111-4111-8111-111111111111/edit': () => ({
        json: {
          url: `${EDITOR}/browser/abc/cool.html?WOPISrc=x`,
          origin: EDITOR,
          accessToken: 'the-token',
          accessTokenTtl: Date.now() + 3600_000,
        },
      }),
    });
    preview(doc());
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const frame = await screen.findByTitle('Editing letter.docx');
    const form = document.querySelector(`form[target="${frame.getAttribute('name')}"]`)!;
    expect(form.getAttribute('action')).toBe(`${EDITOR}/browser/abc/cool.html?WOPISrc=x`);
    expect(form.getAttribute('method')).toBe('post');
    // The token is posted, never put in an address.
    expect((form.querySelector('input[name="access_token"]') as HTMLInputElement).value).toBe(
      'the-token',
    );
    expect(HTMLFormElement.prototype.submit).toHaveBeenCalled();
    expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/edit'))).toBe(true);
  });

  it('closes when the editor says so, and only listens to the editor', async () => {
    mockFetch({
      ...routes('owner'),
      'POST /nodes/11111111-1111-4111-8111-111111111111/edit': () => ({
        json: { url: `${EDITOR}/x`, origin: EDITOR, accessToken: 't', accessTokenTtl: 1 },
      }),
    });
    preview(doc());
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const frame = (await screen.findByTitle('Editing letter.docx')) as HTMLIFrameElement;
    const send = (origin: string, source: Window | null) =>
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: JSON.stringify({ MessageId: 'UI_Close' }),
            origin,
            source,
          }),
        );
      });
    send('https://evil.example.com', frame.contentWindow);
    send(EDITOR, window);
    expect(screen.getByTitle('Editing letter.docx')).toBeInTheDocument();
    send(EDITOR, frame.contentWindow);
    await waitFor(() => expect(screen.queryByTitle('Editing letter.docx')).toBeNull());
  });

  it('isn’t offered to people who can only view, on public links, for old formats, or when off', async () => {
    mockFetch(routes('view'));
    const view = preview(doc());
    await waitFor(() => expect(screen.getByText('letter.docx')).toBeInTheDocument());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    view.unmount();

    mockFetch(routes('owner'));
    const pub = preview(doc(), false);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    pub.unmount();

    const old = preview(doc('letter.doc'));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    old.unmount();

    mockFetch(routes('owner', false));
    preview(doc());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });
});

function status(over: Partial<OfficeStatus> = {}): OfficeStatus {
  return {
    configured: true,
    publicUrl: EDITOR,
    enabled: false,
    running: false,
    pending: null,
    helper: 'ok',
    openDocuments: 0,
    memory: { totalBytes: 8 * GB, availableBytes: 5 * GB },
    ...over,
  };
}

describe('Admin → Settings → Document editor', () => {
  it('says how to add it when it isn’t installed', async () => {
    mockFetch({
      'GET /admin/office': () => ({
        json: status({ configured: false, publicUrl: null, running: null }),
      }),
    });
    const { container } = renderWithProviders(<OfficeCard />);
    expect(await screen.findByText('Off (not installed)')).toBeInTheDocument();
    expect(screen.getByText('./scripts/office.sh on')).toBeInTheDocument();
    expect(
      screen.getByText(/off removes it completely and gives the memory back/),
    ).toBeInTheDocument();
    await expectAccessible(container);
  });

  it('turns it on after showing the memory it needs, and says it can be turned off completely', async () => {
    const calls = mockFetch({
      'GET /admin/office': () => ({ json: status() }),
      'PUT /admin/office': () => ({ json: status({ enabled: true, pending: 'on' }) }),
    });
    const { container } = renderWithProviders(<OfficeCard />);
    expect(await screen.findByText(/Off and removed: it uses no memory/)).toBeInTheDocument();
    expect(
      screen.getByText(
        /If your server doesn't have that to spare, turn this off: it removes the editor completely/,
      ),
    ).toBeInTheDocument();
    await expectAccessible(container);

    await userEvent.click(screen.getByRole('switch', { name: 'Edit documents in the browser' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(
      within(dialog).getByText(/needs about 1–2 GB of memory. This server has 8 GB/),
    ).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Turn on' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ enabled: true }),
    );
    expect(await screen.findByText(/Starting the editor/)).toBeInTheDocument();
  });

  it('recommends leaving it off on a small server', async () => {
    mockFetch({
      'GET /admin/office': () => ({
        json: status({ memory: { totalBytes: 2 * GB, availableBytes: 1 * GB } }),
      }),
    });
    renderWithProviders(<OfficeCard />);
    await userEvent.click(
      await screen.findByRole('switch', { name: 'Edit documents in the browser' }),
    );
    expect(
      await screen.findByText(/With under 4 GB, we recommend leaving it off/),
    ).toBeInTheDocument();
  });

  it('turns it off, and gives the command when the helper can’t remove it', async () => {
    const calls = mockFetch({
      'GET /admin/office': () => ({
        json: status({ enabled: true, running: true, openDocuments: 2 }),
      }),
      'PUT /admin/office': () => ({
        json: status({ enabled: false, running: true, helper: 'missing' }),
      }),
    });
    renderWithProviders(<OfficeCard />);
    expect(await screen.findByText(/2 files were opened or saved/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('switch', { name: 'Edit documents in the browser' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/saved first, then closed/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Turn off' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ enabled: false }),
    );
    expect(await screen.findByText('./scripts/office.sh off')).toBeInTheDocument();
  });
});
