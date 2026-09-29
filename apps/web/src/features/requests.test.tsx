import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { requestTransport } from '../api/upload-manager';
import { expectAccessible, mockFetch, renderWithProviders } from '../test/utils';
import { PublicLinkPage } from './public/PublicLinkPage';
import { ShareDialog } from './sharing/ShareDialog';

const token = 'req_0123456789abcdefghijklmn';
const setupStatus = {
  needsSetup: false,
  appName: 'Family Cloud',
  wordmark: 'Family Cloud',
  logoVersion: null,
  homeUrl: null,
  sourceUrl: 'https://example.com/src',
};

describe('file request page', () => {
  it('asks for files without showing anything of the folder', async () => {
    mockFetch({
      'GET /auth/setup-status': () => ({ json: setupStatus }),
      [`GET /public/links/${token}`]: () => ({
        json: {
          kind: 'upload',
          title: 'Photos from the wedding',
          locked: false,
          allowDownload: false,
          expiresAt: null,
          sharedBy: 'Mum',
          node: null,
        },
      }),
    });
    const { container } = renderWithProviders(
      <Routes>
        <Route path="/s/:token" element={<PublicLinkPage />} />
      </Routes>,
      { route: `/s/${token}` },
    );
    expect(
      await screen.findByRole('heading', { name: 'Photos from the wedding' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Requested by Mum')).toBeInTheDocument();
    expect(screen.getByLabelText('Your name')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose files to send' })).toBeInTheDocument();
    expect(screen.queryByRole('grid')).toBeNull();
    await expectAccessible(container);
  });

  it("sends the sender's name with each upload", async () => {
    const calls = mockFetch({
      [`POST /public/links/${token}/uploads`]: (body) => ({
        json: {
          id: '55555555-5555-4555-8555-555555555555',
          name: (body as { name: string }).name,
          size: 3,
          chunkSize: 4,
          totalChunks: 1,
          receivedChunks: [],
          status: 'uploading',
          expiresAt: new Date().toISOString(),
          done: false,
        },
      }),
    });
    const t = requestTransport(token, () => 'Priya');
    const s = await t.createUpload({ parentId: 'x', name: 'a.jpg', size: 3 });
    expect(s.node).toBeNull();
    expect(calls[0]!.body).toEqual({ name: 'a.jpg', size: 3, from: 'Priya' });
    await expect(t.ensureFolder('x', 'y')).rejects.toThrow(/only files/);
  });
});

describe('share dialog', () => {
  const links = () => ({ json: { items: [] } });
  it('offers "Request files" for folders only', async () => {
    mockFetch({
      'GET /nodes/f1/shares': links,
      'GET /nodes/f1/links': links,
      'GET /users/directory': links,
      'GET /nodes/d1/shares': links,
      'GET /nodes/d1/links': links,
    });
    const { unmount } = renderWithProviders(
      <ShareDialog node={{ id: 'f1', name: 'report.pdf', type: 'file' }} onClose={() => {}} />,
    );
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('tab', { name: 'Request files' })).toBeNull();
    unmount();

    renderWithProviders(
      <ShareDialog node={{ id: 'd1', name: 'Wedding', type: 'folder' }} onClose={() => {}} />,
    );
    const folderDialog = await screen.findByRole('dialog');
    await userEvent.click(within(folderDialog).getByRole('tab', { name: 'Request files' }));
    await waitFor(() =>
      expect(within(folderDialog).getByLabelText('What are you asking for?')).toBeInTheDocument(),
    );
    expect(
      within(folderDialog).getByRole('button', { name: 'Create request link' }),
    ).toBeInTheDocument();
  });
});
