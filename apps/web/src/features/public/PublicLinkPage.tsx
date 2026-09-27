import type { PublicFolder, PublicLinkInfo, PublicNode } from '@familycloud/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Cloud, Download, FolderOpen, Lock } from 'lucide-react';
import { type FormEvent, lazy, Suspense, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { ApiError, api, apiUrl, errorMessage } from '../../api/client';
import { Button, EmptyState, ErrorState, PasswordField, Skeleton } from '../../components/ui';
import { usePageTitle } from '../../lib/usePageTitle';
import { triggerDownload } from '../files/actions';
import { FileView } from '../files/FileView';

const PreviewModal = lazy(() => import('../files/PreviewModal'));

function Frame({ sharedBy, children }: { sharedBy?: string; children: React.ReactNode }) {
  return (
    <div className="min-h-dvh">
      <header className="flex h-14 items-center gap-2 border-b border-border px-4">
        <span
          aria-hidden="true"
          className="flex size-7 items-center justify-center rounded-lg bg-accent text-accent-fg"
        >
          <Cloud size={16} />
        </span>
        <span className="text-sm font-semibold">Family Cloud</span>
        {sharedBy && <span className="ml-auto text-xs text-muted">Shared by {sharedBy}</span>}
      </header>
      <main className="mx-auto max-w-5xl px-3 py-5 md:px-6">{children}</main>
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
  const folder = useQuery({
    queryKey: ['public', token, 'folder', folderId ?? ''],
    queryFn: () => api<PublicFolder>(`${base}/folder`, { query: { folderId } }),
    enabled: !!info.data && !info.data.locked && isFolder,
  });
  const [password, setPassword] = useState('');
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  const [preview, setPreview] = useState<number | null>(null);

  usePageTitle(info.data?.node ? info.data.node.name : 'Shared with you');

  const source = useMemo(
    () => ({
      content: (id: string, inline: boolean) =>
        apiUrl(`${base}/content/${id}`, inline ? { inline: 1 } : undefined),
      thumb: (id: string, size: 256 | 1600) => apiUrl(`${base}/thumbnail/${id}`, { size }),
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
    const expired = info.error instanceof ApiError && info.error.status === 410;
    return (
      <Frame>
        <ErrorState
          title={expired ? 'This link has expired' : 'Link not found'}
          error={
            expired
              ? 'Ask the person who shared it for a new link.'
              : 'It may have been removed or mistyped.'
          }
        />
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

  const root = data.node!;
  if (!isFolder) {
    return (
      <Frame sharedBy={data.sharedBy}>
        <div className="flex flex-col items-center gap-4 py-10 text-center">
          <h1 className="text-xl font-semibold break-all">{root.name}</h1>
          <div className="flex gap-2">
            <Button variant="primary" icon={<FolderOpen size={16} />} onClick={() => setPreview(0)}>
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
        {preview !== null && (
          <Suspense fallback={null}>
            <PreviewModal
              items={[root]}
              index={0}
              onIndexChange={() => {}}
              onClose={() => setPreview(null)}
              source={source}
            />
          </Suspense>
        )}
      </Frame>
    );
  }

  const items: PublicNode[] = folder.data?.items ?? [];
  const files = items.filter((i) => i.type === 'file');
  return (
    <Frame sharedBy={data.sharedBy}>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <nav aria-label="Folder path" className="min-w-0 flex-1 text-sm">
          {folder.data?.breadcrumbs.map((b, i, arr) => (
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
        {data.allowDownload && folder.data && (
          <Button
            icon={<Download size={16} />}
            onClick={() => triggerDownload(apiUrl(`${base}/zip/${folder.data.folder.id}`))}
          >
            Download all
          </Button>
        )}
      </div>
      {folder.isPending ? (
        <Skeleton className="h-64" />
      ) : items.length === 0 ? (
        <EmptyState icon={<FolderOpen />} title="This folder is empty" />
      ) : (
        <FileView<PublicNode>
          items={items}
          view="list"
          label={`Contents of ${folder.data?.folder.name ?? root.name}`}
          onOpen={(n) =>
            n.type === 'folder'
              ? setParams({ folder: n.id })
              : setPreview(files.findIndex((f) => f.id === n.id))
          }
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
      {preview !== null && preview >= 0 && (
        <Suspense fallback={null}>
          <PreviewModal
            items={files}
            index={preview}
            onIndexChange={setPreview}
            onClose={() => setPreview(null)}
            source={source}
          />
        </Suspense>
      )}
    </Frame>
  );
}
