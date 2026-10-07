import type { PhotoSocial } from '@familycloud/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { expectAccessible, mockFetch, renderWithProviders } from '../test/utils';
import { PhotoSocialBar } from './photos/PhotoSocial';

const albumId = '11111111-1111-4111-8111-111111111111';
const photo = {
  id: '22222222-2222-4222-8222-222222222222',
  hearts: 1,
  hearted: false,
  comments: 1,
};
const base = `/albums/${albumId}/photos/${photo.id}`;
const mom = { id: '33333333-3333-4333-8333-333333333333', displayName: 'Mom' };
const me = { id: '44444444-4444-4444-8444-444444444444', displayName: 'Kid' };
const comment = (id: string, body: string, author = mom, canDelete = false) => ({
  id,
  author,
  body,
  createdAt: new Date().toISOString(),
  canDelete,
});
const before: PhotoSocial = {
  hearts: [mom],
  hearted: false,
  comments: [comment('55555555-5555-4555-8555-555555555555', 'Lovely!')],
};

describe('hearts and comments', () => {
  it('hearts a photo and adds a comment', async () => {
    const calls = mockFetch({
      [`GET ${base}/social`]: () => ({ json: before }),
      [`PUT ${base}/heart`]: () => ({ json: { ...before, hearts: [mom, me], hearted: true } }),
      [`POST ${base}/comments`]: (body) => ({
        json: {
          ...before,
          hearts: [mom, me],
          hearted: true,
          comments: [
            ...before.comments,
            comment(
              '66666666-6666-4666-8666-666666666666',
              (body as { body: string }).body,
              me,
              true,
            ),
          ],
        },
      }),
    });
    renderWithProviders(<PhotoSocialBar albumId={albumId} photo={photo} />);
    const heart = screen.getByRole('button', { name: 'Give it a heart' });
    expect(await screen.findByText(/♥ Mom/)).toBeInTheDocument();
    await userEvent.click(heart);
    expect(await screen.findByRole('button', { name: 'Remove your heart' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByText('♥ Mom, Kid')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /1 comment/ }));
    expect(screen.getByText('Lovely!')).toBeInTheDocument();
    // Only your own comments (or those on your photo) can be deleted.
    expect(screen.queryByRole('button', { name: /Delete Mom’s comment/ })).toBeNull();
    await userEvent.type(screen.getByLabelText('Write a comment'), 'So pretty{Enter}');
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ body: 'So pretty' }),
    );
    expect(await screen.findByText('So pretty')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete Kid’s comment' })).toBeInTheDocument();
    expect(screen.getByLabelText('Write a comment')).toHaveValue('');
    await expectAccessible(document.body);
    expect(within(document.body).getByRole('button', { name: /2 comments/ })).toBeInTheDocument();
  });

  it('asks before deleting a comment', async () => {
    const mine = comment('77777777-7777-4777-8777-777777777777', 'Wish I was there', me, true);
    const calls = mockFetch({
      [`GET ${base}/social`]: () => ({ json: { ...before, comments: [mine] } }),
      [`DELETE ${base}/comments/${mine.id}`]: () => ({ json: { ...before, comments: [] } }),
    });
    renderWithProviders(<PhotoSocialBar albumId={albumId} photo={photo} />);
    await userEvent.click(screen.getByRole('button', { name: /1 comment/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Kid’s comment' }));
    const ask = await screen.findByRole('alertdialog', { name: 'Delete Kid’s comment?' });
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    await userEvent.click(within(ask).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText('Wish I was there')).toBeNull());
  });
});
