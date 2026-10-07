import type { PublicFolder, PublicLinkInfo, PublicNode } from '@familycloud/shared';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FolderOpen, Lock } from 'lucide-react';
import { type FormEvent, lazy, Suspense, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { ApiError, api, apiUrl, errorMessage, isUnusableLink } from '../../api/client';
import { Logo } from '../../app/Logo';
import { Button, EmptyState, ErrorState, PasswordField, Skeleton } from '../../components/ui';
import { usePageTitle } from '../../lib/usePageTitle';
import { triggerDownload } from '../files/actions';
import { FileView } from '../files/FileView';
import { RequestUpload } from './RequestUpload';

const PreviewModal = lazy(() => import('../files/PreviewModal'));

function Frame({
  sharedBy,
  request = false,
  children,
}: {
  sharedBy?: string;
  request?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-dvh">
      <header className="flex h-14 items-center gap-2 border-b border-border px-4">
        <Logo size="sm" />
        {sharedBy && (
          <span className="ml-auto shrink-0 text-xs text-muted">
            {request ? 'Requested' : 'Shared'} by {sharedBy}
          </span>
        )}
      </header>
      <main className="mx-auto max-w-5xl px-3 py-5 md:px-6">{children}</main>
      <footer className="flex justify-center pb-6 text-sm text-muted">
        <Link to="/privacy" className="inline-flex min-h-11 items-center hover:text-text">
          Privacy
        </Link>
      </footer>
    </div>
  );
}

/** What someone without an account sees when opening a /s/<token> link. */
export function PublicLinkPage() {
  const { token = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const folderId = params.get('folder') ?? undefined;
  const qc = useQueryClient();
  const base = `/public/links/${token}`;

  const info = useQuery({
    queryKey: ['public', token],
    queryFn: () => api<PublicLinkInfo>(base),
    retry: false,
  });
  const isFolder = info.data?.node?.type === 'folder';
  const folder = useInfiniteQuery({
    queryKey: ['public', token, 'folder', folderId ?? ''],
    queryFn: ({ pageParam, signal }) =>
      api<PublicFolder>(`${base}/folder`, { query: { folderId, cursor: pageParam }, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: !!info.data && !info.data.locked && isFolder,
  });
  const listing = folder.data?.pages[0];
  const items: PublicNode[] = useMemo(
    () => folder.data?.pages.flatMap((pg) => pg.items) ?? [],
    [folder.data],
  );
  const [password, setPassword] = useState('');
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  // By id: the index would drift if the listing refreshes while a preview is open.
  const [previewId, setPreviewId] = useState<string | null>(null);

  usePageTitle(
    info.data?.node
      ? info.data.node.name
      : info.data?.kind === 'upload'
        ? (info.data.title ?? 'Send files')
        : 'Shared with you',
  );

  const source = useMemo(
    () => ({
      content: (id: string, inline: boolean) =>
        apiUrl(`${base}/content/${id}`, inline ? { inline: 1 } : undefined),
      thumb: (id: string, size: 256 | 1600) => apiUrl(`${base}/thumbnail/${id}`, { size }),
      stream: (id: string) => apiUrl(`${base}/stream/${id}`),
      preview: (id: string) => apiUrl(`${base}/preview/${id}`),
      canDownload: !!info.data?.allowDownload,
    }),
    [base, info.data?.allowDownload],
  );

  if (info.isPending) {
    return (
      <Frame>
        <Skeleton className="h-64" />
      </Frame>
    );
  }
  if (info.isError) {
    return (
      <Frame>
        {info.error instanceof ApiError && info.error.status === 410 ? (
          <ErrorState
            title="This link has expired"
            error="Ask the person who shared it for a new link."
          />
        ) : isUnusableLink(info.error) ? (
          <ErrorState title="Link not found" error="It may have been removed or mistyped." />
        ) : (
          // No connection, the server restarting, too many tries: the link itself may be fine.
          <ErrorState
            title="Couldn't open this link"
            error={info.error}
            onRetry={() => void info.refetch()}
          />
        )}
      </Frame>
    );
  }

  const data = info.data;
  if (data.locked) {
    const unlock = async (e: FormEvent) => {
      e.preventDefault();
      setUnlocking(true);
      setUnlockError(null);
      try {
        await api(`${base}/unlock`, { json: { password } });
        await qc.invalidateQueries({ queryKey: ['public', token] });
      } catch (err) {
        setUnlockError(errorMessage(err));
      } finally {
        setUnlocking(false);
      }
    };
    return (
      <Frame sharedBy={data.sharedBy}>
        <form
          onSubmit={unlock}
          className="mx-auto mt-10 flex max-w-sm flex-col gap-4 rounded-2xl border border-border bg-surface p-6"
        >
          <div className="flex items-center gap-2">
            <Lock size={18} aria-hidden />
            <h1 className="font-semibold">This link is password-protected</h1>
          </div>
          <PasswordField
            label="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={unlockError}
            autoFocus
            required
          />
          <Button type="submit" variant="primary" loading={unlocking}>
            Open
          </Button>
        </form>
      </Frame>
    );
  }

  if (data.kind === 'upload') {
    return (
      <Frame sharedBy={data.sharedBy} request>
        <RequestUpload token={token} info={data} />
      </Frame>
    );
  }

  const root = data.node!;
  if (!isFolder) {
    return (
      <Frame sharedBy={data.sharedBy}>
        <div className="flex flex-col items-center gap-4 py-10 text-center">
          <h1 className="text-xl font-semibold break-all">{root.name}</h1>
          <div className="flex gap-2">
            <Button
              variant="primary"
              icon={<FolderOpen size={16} />}
              onClick={() => setPreviewId(root.id)}
            >
              Preview
            </Button>
            {data.allowDownload && (
              <Button
                icon={<Download size={16} />}
                onClick={() => triggerDownload(source.content(root.id, false))}
              >
                Download
              </Button>
            )}
          </div>
        </div>
        {previewId !== null && (
          <Suspense fallback={null}>
            <PreviewModal
              items={[root]}
              index={0}
              onIndexChange={() => {}}
              onClose={() => setPreviewId(null)}
              source={source}
            />
          </Suspense>
        )}
      </Frame>
    );
  }

  const files = items.filter((i) => i.type === 'file');
  const previewIndex = previewId ? files.findIndex((f) => f.id === previewId) : -1;
  return (
    <Frame sharedBy={data.sharedBy}>
      <h1 className="sr-only">{listing?.folder.name ?? root.name}</h1>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <nav aria-label="Folder path" className="min-w-0 flex-1 text-sm">
          {listing?.breadcrumbs.map((b, i, arr) => (
            <span key={b.id}>
              {i > 0 && <span className="px-1 text-muted">/</span>}
              {i === arr.length - 1 ? (
                <span aria-current="page" className="font-semibold">
                  {b.name}
                </span>
              ) : (
                <button
                  type="button"
                  className="text-accent hover:underline"
                  onClick={() => setParams(i === 0 ? {} : { folder: b.id })}
                >
                  {b.name}
                </button>
              )}
            </span>
          ))}
        </nav>
        {data.allowDownload && listing && (
          <Button
            icon={<Download size={16} />}
            onClick={() => triggerDownload(apiUrl(`${base}/zip/${listing.folder.id}`))}
          >
            Download all
          </Button>
        )}
      </div>
      {folder.isPending ? (
        <Skeleton className="h-64" />
      ) : folder.isError ? (
        <ErrorState
          title="Couldn't open this folder"
          error={folder.error}
          onRetry={() => void folder.refetch()}
        />
      ) : items.length === 0 ? (
        <EmptyState icon={<FolderOpen />} title="This folder is empty" />
      ) : (
        <FileView<PublicNode>
          // A fresh list per folder: focus, selection and scroll don't carry over.
          key={folderId ?? 'root'}
          items={items}
          hasMore={folder.hasNextPage}
          loadingMore={folder.isFetchingNextPage}
          onLoadMore={() => void folder.fetchNextPage()}
          view="list"
          label={`Contents of ${listing?.folder.name ?? root.name}`}
          onOpen={(n) => (n.type === 'folder' ? setParams({ folder: n.id }) : setPreviewId(n.id))}
          thumbSrc={(n) => (n.thumb === 'ready' ? source.thumb(n.id, 256) : undefined)}
          actionsFor={(n) =>
            data.allowDownload
              ? [
                  {
                    id: 'download',
                    label: n.type === 'folder' ? 'Download as zip' : 'Download',
                    icon: <Download />,
                    onSelect: () =>
                      triggerDownload(
                        n.type === 'folder'
                          ? apiUrl(`${base}/zip/${n.id}`)
                          : source.content(n.id, false),
                      ),
                  },
                ]
              : []
          }
        />
      )}
      {previewIndex >= 0 && (
        <Suspense fallback={null}>
          <PreviewModal
            items={files}
            index={previewIndex}
            onIndexChange={(i) => setPreviewId(files[i]?.id ?? null)}
            onClose={() => setPreviewId(null)}
            source={source}
          />
        </Suspense>
      )}
    </Frame>
  );
}
