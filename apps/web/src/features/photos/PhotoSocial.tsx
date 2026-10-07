import type { AlbumPhotoPage, PhotoComment, PhotoSocial } from '@familycloud/shared';
import { type InfiniteData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Heart, MessageCircle, Send, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api, errorMessage } from '../../api/client';
import { qk } from '../../api/queries';
import { Avatar, ConfirmDialog, toast } from '../../components/ui';
import { formatRelative } from '../../lib/format';

const socialKey = (albumId: string, nodeId: string) =>
  ['albums', 'social', albumId, nodeId] as const;

/**
 * Hearts and comments under a photo in the album viewer. Every change answers with the photo's
 * hearts and comments, which also update the counts on the album grid without reloading it.
 */
export function PhotoSocialBar({
  albumId,
  photo,
}: {
  albumId: string;
  photo: { id: string; hearts: number; hearted: boolean; comments: number };
}) {
  const qc = useQueryClient();
  const key = socialKey(albumId, photo.id);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [deleting, setDeleting] = useState<PhotoComment | null>(null);
  const social = useQuery({
    queryKey: key,
    queryFn: () => api<PhotoSocial>(`/albums/${albumId}/photos/${photo.id}/social`),
  });
  const base = `/albums/${albumId}/photos/${photo.id}`;

  const settle = (s: PhotoSocial) => {
    qc.setQueryData(key, s);
    qc.setQueryData<InfiniteData<AlbumPhotoPage>>(qk.albumPhotos(albumId), (data) =>
      data
        ? {
            ...data,
            pages: data.pages.map((p) => ({
              ...p,
              items: p.items.map((i) =>
                i.id === photo.id
                  ? {
                      ...i,
                      hearts: s.hearts.length,
                      hearted: s.hearted,
                      comments: s.comments.length,
                    }
                  : i,
              ),
            })),
          }
        : data,
    );
  };
  const change = useMutation({
    mutationFn: (req: { method: 'PUT' | 'POST' | 'DELETE'; path: string; json?: object }) =>
      api<PhotoSocial>(`${base}${req.path}`, { method: req.method, json: req.json }),
    onSuccess: settle,
    onError: (err) => toast.error(errorMessage(err)),
  });

  const s = social.data;
  const hearted = s?.hearted ?? photo.hearted;
  const hearts = s?.hearts.length ?? photo.hearts;
  const comments = s?.comments.length ?? photo.comments;
  const heartNames = s?.hearts.map((h) => h.displayName).join(', ');

  const send = () => {
    const body = draft.trim();
    if (!body) return;
    change.mutate(
      { method: 'POST', path: '/comments', json: { body } },
      { onSuccess: () => setDraft('') },
    );
  };

  const pill =
    'flex min-h-11 items-center gap-1.5 rounded-full px-3 text-sm text-white/85 hover:bg-white/10 hover:text-white';
  return (
    // Typing here must not page through photos.
    <div data-own-keys className="mx-auto flex w-full max-w-xl flex-col gap-2 px-3 pb-2 text-white">
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-pressed={hearted}
          aria-label={hearted ? 'Remove your heart' : 'Give it a heart'}
          title={heartNames || undefined}
          disabled={change.isPending}
          onClick={() => change.mutate({ method: hearted ? 'DELETE' : 'PUT', path: '/heart' })}
          className={pill}
        >
          <Heart
            size={20}
            aria-hidden
            className={hearted ? 'fill-red-500 text-red-500' : undefined}
          />
          <span className="tabular-nums">{hearts || ''}</span>
        </button>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className={pill}
        >
          <MessageCircle size={20} aria-hidden />
          <span className="tabular-nums">
            {comments ? `${comments} ${comments === 1 ? 'comment' : 'comments'}` : 'Comment'}
          </span>
        </button>
        {heartNames && (
          <p className="min-w-0 flex-1 truncate text-right text-xs text-white/60">♥ {heartNames}</p>
        )}
      </div>
      {open && (
        <div className="flex max-h-[38dvh] flex-col gap-2 overflow-hidden rounded-2xl bg-white/10">
          <ul className="flex min-h-0 flex-col gap-3 overflow-y-auto overscroll-contain p-3">
            {s?.comments.length === 0 && (
              <li className="text-sm text-white/60">No comments yet. Say something nice.</li>
            )}
            {s?.comments.map((c) => (
              <li key={c.id} className="flex gap-2">
                <Avatar name={c.author.displayName} size={28} />
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-white/60">
                    <span className="font-medium text-white/90">{c.author.displayName}</span> ·{' '}
                    {formatRelative(c.createdAt)}
                  </p>
                  <p className="text-sm break-words whitespace-pre-line">{c.body}</p>
                </div>
                {c.canDelete && (
                  <button
                    type="button"
                    aria-label={`Delete ${c.author.displayName}’s comment`}
                    onClick={() => setDeleting(c)}
                    className="flex size-9 shrink-0 items-center justify-center rounded-lg text-white/50 hover:bg-white/10 hover:text-white pointer-coarse:size-11"
                  >
                    <Trash2 size={16} aria-hidden />
                  </button>
                )}
              </li>
            ))}
          </ul>
          <form
            className="flex items-end gap-2 border-t border-white/10 p-2"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <label htmlFor={`comment-${photo.id}`} className="sr-only">
              Write a comment
            </label>
            <textarea
              id={`comment-${photo.id}`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={1}
              maxLength={1000}
              placeholder="Write a comment…"
              // 16px so iPhones don't zoom in on it.
              className="max-h-28 min-h-11 flex-1 resize-none rounded-xl bg-black/30 px-3 py-2.5 text-base text-white placeholder:text-white/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
            />
            <button
              type="submit"
              aria-label="Send comment"
              disabled={!draft.trim() || change.isPending}
              className="flex size-11 shrink-0 items-center justify-center rounded-full bg-white/90 text-black disabled:opacity-40"
            >
              <Send size={18} aria-hidden />
            </button>
          </form>
        </div>
      )}
      {/* A deleted comment can't come back, and the photo's owner can delete anyone's. */}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        tone="danger"
        title={`Delete ${deleting?.author.displayName}’s comment?`}
        description={`“${deleting?.body}” This can't be undone.`}
        confirmLabel="Delete"
        onConfirm={() =>
          deleting && change.mutateAsync({ method: 'DELETE', path: `/comments/${deleting.id}` })
        }
      />
    </div>
  );
}
