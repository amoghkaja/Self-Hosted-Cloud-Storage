import { type AlbumPhoto, GiB, type ShareLink } from '@familycloud/shared';
import {
  ArrowLeft,
  Download,
  EllipsisVertical,
  Heart,
  ImagePlus,
  Images,
  Inbox,
  MessageCircle,
  Pencil,
  Play,
  Trash2,
  Users,
} from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, apiUrl, errorMessage } from '../../api/client';
import { albumFolder, useAlbum, useAlbumMutations, useAlbumPhotos } from '../../api/queries';
import { useShell } from '../../app/guards';
import { uploadManager } from '../../app/providers';
import {
  Avatar,
  Button,
  ConfirmDialog,
  Dialog,
  DropdownMenu,
  EmptyState,
  IconButton,
  QueryState,
  SelectField,
  Skeleton,
  toast,
} from '../../components/ui';
import { usePageTitle } from '../../lib/usePageTitle';
import { triggerDownload } from '../files/actions';
import type { PreviewItem, PreviewSource } from '../files/PreviewModal';
import { LinkBox } from '../sharing/LinkActions';
import { dayLabel, groupByDay } from './days';
import { PhotoSocialBar } from './PhotoSocial';
import { TripDialog, tripDates } from './TripForm';

const PreviewModal = lazy(() => import('../files/PreviewModal'));

function Tile({ p, albumId, onOpen }: { p: AlbumPhoto; albumId: string; onOpen: () => void }) {
  const video = p.mimeType?.startsWith('video/');
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-label={[
          `${p.name}, added by ${p.addedBy.displayName}`,
          p.hearts ? `${p.hearts} ${p.hearts === 1 ? 'heart' : 'hearts'}` : '',
          p.comments ? `${p.comments} ${p.comments === 1 ? 'comment' : 'comments'}` : '',
        ]
          .filter(Boolean)
          .join(', ')}
        className="group relative block aspect-square w-full overflow-hidden bg-surface-2"
      >
        {p.thumb === 'ready' ? (
          <img
            src={apiUrl(`/albums/${albumId}/photos/${p.id}/thumbnail`, { size: '256' })}
            alt=""
            loading="lazy"
            decoding="async"
            className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.04]"
          />
        ) : (
          <span className="flex size-full items-center justify-center text-muted">
            <Images
              size={22}
              aria-hidden
              className={p.thumb === 'pending' ? 'animate-pulse' : ''}
            />
          </span>
        )}
        {(p.hearts > 0 || p.comments > 0) && (
          <span className="absolute bottom-1.5 left-1.5 flex items-center gap-1.5 rounded-full bg-black/55 px-1.5 py-0.5 text-[11px] text-white tabular-nums">
            {p.hearts > 0 && (
              <span className="flex items-center gap-0.5">
                <Heart size={11} aria-hidden fill="currentColor" />
                {p.hearts}
              </span>
            )}
            {p.comments > 0 && (
              <span className="flex items-center gap-0.5">
                <MessageCircle size={11} aria-hidden />
                {p.comments}
              </span>
            )}
          </span>
        )}
        {video && (
          <span className="absolute right-1.5 bottom-1.5 flex size-6 items-center justify-center rounded-full bg-black/55 text-white">
            <Play size={12} aria-hidden fill="currentColor" />
          </span>
        )}
      </button>
    </li>
  );
}

/**
 * A file request into the caller's own folder for this album: relatives without an account send
 * their photos straight into the family album (they count toward the caller's storage).
 */
function AskForPhotosDialog({
  albumId,
  title,
  onClose,
}: {
  albumId: string;
  title: string;
  onClose: () => void;
}) {
  const [days, setDays] = useState('30');
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const { folderId } = await albumFolder(albumId);
      const link = await api<ShareLink>(`/nodes/${folderId}/links`, {
        json: {
          kind: 'upload',
          title: `Photos for “${title}”`,
          allowDownload: false,
          // Trips bring videos: more room than a request's usual 5 GB.
          maxUploadBytes: 20 * GiB,
          expiresAt: days ? new Date(Date.now() + Number(days) * 86_400_000).toISOString() : null,
        },
      });
      setUrl(link.url);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Ask for photos"
      size="md"
      footer={
        url ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={create}>
              Create link
            </Button>
          </>
        )
      }
    >
      {url ? (
        <div className="flex flex-col gap-3 text-sm">
          <p>
            Send this to anyone who has photos from the trip. They don't need an account, and they
            can't see the album.
          </p>
          <LinkBox url={url} title={`Photos for “${title}”`} copyLabel="Copy link" />
          <p className="text-xs text-muted">
            Stop it any time from Shared by me. What they send counts toward your storage.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3 text-sm">
          <p>
            Get a link for friends and relatives to send their photos and videos straight into this
            album, without an account. They only see an upload page, never the album itself.
          </p>
          <SelectField
            label="Take photos for"
            value={days}
            onChange={(e) => setDays(e.target.value)}
          >
            <option value="7">7 days</option>
            <option value="30">30 days</option>
            <option value="90">90 days</option>
          </SelectField>
        </div>
      )}
    </Dialog>
  );
}

export function AlbumPage() {
  const { albumId = '' } = useParams();
  const { me } = useShell();
  const navigate = useNavigate();
  const album = useAlbum(albumId);
  const photos = useAlbumPhotos(albumId);
  const m = useAlbumMutations();
  const picker = useRef<HTMLInputElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [asking, setAsking] = useState(false);
  usePageTitle(album.data?.title ?? 'Photos');

  const items = useMemo(() => photos.data?.pages.flatMap((p) => p.items) ?? [], [photos.data]);
  const days = useMemo(() => groupByDay(items), [items]);
  const previewItems: PreviewItem[] = useMemo(
    () => items.map((p) => ({ ...p, type: 'file' as const })),
    [items],
  );
  const source: PreviewSource = useMemo(
    () => ({
      content: (id, inline) =>
        apiUrl(`/albums/${albumId}/photos/${id}/content`, inline ? { inline: '1' } : undefined),
      thumb: (id, size) =>
        apiUrl(`/albums/${albumId}/photos/${id}/thumbnail`, { size: String(size) }),
      stream: (id) => apiUrl(`/albums/${albumId}/photos/${id}/stream`),
      canDownload: true,
    }),
    [albumId],
  );

  // Load more as the end of the grid scrolls into view.
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = photos;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNextPage) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
      },
      { rootMargin: '600px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Takes an array, not the input's FileList: that list empties as soon as the input is reset.
  const addPhotos = async (files: File[]) => {
    if (!files.length) return;
    setAdding(true);
    try {
      const { folderId } = await albumFolder(albumId);
      uploadManager.add(
        folderId,
        files.map((file) => ({ file, relativeDir: '' })),
      );
      toast.success(
        `Uploading ${files.length} ${files.length === 1 ? 'photo' : 'photos'} to the family album. They appear here as they finish.`,
      );
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setAdding(false);
    }
  };

  const previewIndex = previewId ? items.findIndex((p) => p.id === previewId) : -1;

  return (
    <QueryState query={album} loading={<Skeleton className="h-72" />}>
      {(a) => (
        <div className="mx-auto flex max-w-6xl flex-col gap-5">
          <Link
            to="/photos"
            className="inline-flex min-h-11 items-center gap-1.5 self-start text-sm text-muted hover:text-text"
          >
            <ArrowLeft size={16} aria-hidden /> All trips
          </Link>
          <header className="flex flex-col gap-4 sm:flex-row sm:items-end">
            <div className="min-w-0 sm:flex-1">
              <p className="text-xs font-medium tracking-[0.22em] text-accent uppercase">
                {tripDates(a.startDate, a.endDate)}
              </p>
              <h1 className="font-display text-4xl leading-tight break-words sm:text-5xl">
                {a.title}
              </h1>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-muted">
                {a.people.map((p) => (
                  <span
                    key={p.id}
                    className="flex items-center gap-1.5 rounded-full bg-surface-2 py-1 pr-3 pl-1"
                  >
                    <Avatar name={p.displayName} size={22} />
                    {p.id === me.id ? 'You' : p.displayName}
                  </span>
                ))}
                <span>
                  {a.photoCount} {a.photoCount === 1 ? 'photo' : 'photos'}
                </span>
              </div>
              <p className="mt-3 flex items-center gap-1.5 text-sm text-muted">
                <Users size={16} aria-hidden className="shrink-0 text-accent" />
                Family album: everyone in the family can see these photos.
              </p>
            </div>
            <div className="flex items-center gap-2">
              {a.canContribute && (
                <>
                  <input
                    ref={picker}
                    type="file"
                    // iPhone opens the photo library (and camera) for this.
                    accept="image/*,video/*"
                    multiple
                    className="sr-only"
                    tabIndex={-1}
                    aria-hidden="true"
                    onChange={(e) => {
                      void addPhotos([...(e.target.files ?? [])]);
                      e.target.value = '';
                    }}
                  />
                  <Button
                    variant="primary"
                    icon={<ImagePlus size={16} />}
                    loading={adding}
                    className="flex-1 sm:flex-none"
                    onClick={() => picker.current?.click()}
                  >
                    Add photos
                  </Button>
                </>
              )}
              <DropdownMenu
                label="Album actions"
                trigger={<IconButton label="More" icon={<EllipsisVertical />} />}
                actions={[
                  {
                    id: 'download',
                    label: 'Download all',
                    icon: <Download />,
                    disabled: a.photoCount === 0,
                    onSelect: () => triggerDownload(apiUrl(`/albums/${a.id}/zip`)),
                  },
                  ...(a.canContribute
                    ? [
                        {
                          id: 'ask',
                          label: 'Ask for photos…',
                          icon: <Inbox />,
                          onSelect: () => setAsking(true),
                        },
                      ]
                    : []),
                  ...(a.canEdit
                    ? [
                        {
                          id: 'edit',
                          label: 'Edit trip',
                          icon: <Pencil />,
                          onSelect: () => setEditing(true),
                        },
                        {
                          id: 'delete',
                          label: 'Delete album',
                          icon: <Trash2 />,
                          tone: 'danger' as const,
                          separatorBefore: true,
                          onSelect: () => setDeleting(true),
                        },
                      ]
                    : []),
                ]}
              />
            </div>
          </header>

          <QueryState
            query={photos}
            loading={<Skeleton className="h-64" />}
            isEmpty={() => items.length === 0}
            empty={
              <EmptyState
                icon={<ImagePlus />}
                title="No photos yet"
                description={
                  a.canContribute
                    ? 'Add photos straight from your phone. Everyone on the trip can add theirs.'
                    : 'Photos appear here when people on the trip add them.'
                }
                action={
                  a.canContribute ? (
                    <Button
                      variant="primary"
                      icon={<ImagePlus size={16} />}
                      onClick={() => picker.current?.click()}
                    >
                      Add photos
                    </Button>
                  ) : undefined
                }
              />
            }
          >
            {() => (
              <>
                <div className="flex flex-col gap-6">
                  {days.map((d) => (
                    <section
                      key={`${d.day}-${d.items[0]!.id}`}
                      aria-label={dayLabel(d.day, a.startDate, a.endDate)}
                    >
                      <h2 className="mb-2 text-sm font-medium text-muted">
                        {dayLabel(d.day, a.startDate, a.endDate)}
                      </h2>
                      <ul className="-mx-3 grid grid-cols-3 gap-0.5 sm:mx-0 sm:grid-cols-4 sm:gap-1 lg:grid-cols-6">
                        {d.items.map((p) => (
                          <Tile key={p.id} p={p} albumId={a.id} onOpen={() => setPreviewId(p.id)} />
                        ))}
                      </ul>
                    </section>
                  ))}
                </div>
                <div ref={sentinel} aria-hidden="true" />
                {isFetchingNextPage && <Skeleton className="h-24" />}
              </>
            )}
          </QueryState>

          {previewIndex >= 0 && (
            <Suspense fallback={null}>
              <PreviewModal
                items={previewItems}
                index={previewIndex}
                onIndexChange={(i) => setPreviewId(previewItems[i]?.id ?? null)}
                onClose={() => setPreviewId(null)}
                source={source}
                footer={(item) => {
                  const photo = items.find((p) => p.id === item.id);
                  return photo ? (
                    <PhotoSocialBar key={photo.id} albumId={a.id} photo={photo} />
                  ) : null;
                }}
              />
            </Suspense>
          )}
          {asking && (
            <AskForPhotosDialog albumId={a.id} title={a.title} onClose={() => setAsking(false)} />
          )}
          {editing && (
            <TripDialog
              me={me}
              title="Edit trip"
              submitLabel="Save"
              initial={{
                title: a.title,
                startDate: a.startDate,
                endDate: a.endDate,
                peopleIds: a.people.map((p) => p.id),
              }}
              onClose={() => setEditing(false)}
              onSubmit={async (input) => {
                await m.update.mutateAsync({ id: a.id, ...input });
                setEditing(false);
                toast.success('Trip updated');
              }}
            />
          )}
          {deleting && (
            <ConfirmDialog
              open
              onOpenChange={(o) => !o && setDeleting(false)}
              title={`Delete the album “${a.title}”?`}
              description="The photos stay where they are, in each person’s Trips folder in their files. Only the album goes."
              confirmLabel="Delete album"
              tone="danger"
              onConfirm={async () => {
                try {
                  await m.remove.mutateAsync(a.id);
                  navigate('/photos', { replace: true });
                } catch (err) {
                  toast.error(errorMessage(err));
                }
              }}
            />
          )}
        </div>
      )}
    </QueryState>
  );
}
