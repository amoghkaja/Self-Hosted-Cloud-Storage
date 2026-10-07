import { type FileNode, formatBytes } from '@familycloud/shared';
import { Clock, RotateCcw, Search, Star, Trash2, Users } from 'lucide-react';
import { lazy, Suspense, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { contentUrl, errorMessage, previewUrl, streamUrl, thumbUrl } from '../../api/client';
import {
  useDirectory,
  usePurge,
  useRecent,
  useRestore,
  useSearch,
  useSharedWithMe,
  useStarred,
  useTrash,
} from '../../api/queries';
import { useShell } from '../../app/guards';
import { SearchBox } from '../../app/SearchBox';
import { FILES_SECTIONS, SHARED_SECTIONS } from '../../app/sections';
import {
  Button,
  ConfirmDialog,
  EmptyState,
  IconButton,
  QueryState,
  SectionLinks,
  Skeleton,
  toast,
} from '../../components/ui';
import { formatRelative } from '../../lib/format';
import { usePref } from '../../lib/storage';
import { usePageTitle } from '../../lib/usePageTitle';
import { useFileActions } from './actions';
import { FileIcon } from './FileIcon';
import { FileView, FileViewSkeleton } from './FileView';

const PreviewModal = lazy(() => import('./PreviewModal'));

function PageTitle({
  title,
  sections,
  children,
}: {
  title: string;
  sections?: { label: string; items: { to: string; label: string }[] };
  children?: React.ReactNode;
}) {
  usePageTitle(title);
  return (
    <>
      {sections && <SectionLinks {...sections} />}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="flex-1 text-xl font-semibold">{title}</h1>
        {children}
      </div>
    </>
  );
}

/** Files list with preview for flat collections (search results, shared-with-me). */
function FlatList({
  nodes,
  label,
  subtitle,
  editable,
  contentEditable,
}: {
  nodes: FileNode[];
  label: string;
  subtitle?: (n: FileNode) => string;
  editable: (n: FileNode) => boolean;
  /** Files whose contents the caller may change (see useFileActions). */
  contentEditable?: (n: FileNode) => boolean;
}) {
  const { me } = useShell();
  const [view] = usePref<'list' | 'grid'>('view', 'list');
  const files = useMemo(() => nodes.filter((n) => n.type === 'file'), [nodes]);
  // By id: results refresh underneath an open preview (e.g. after a rename or trash).
  const [previewId, setPreviewId] = useState<string | null>(null);
  const previewIndex = previewId ? files.findIndex((f) => f.id === previewId) : -1;
  const actions = useFileActions({
    onPreview: (n) => setPreviewId(n.id),
    canEdit: editable,
    canEditContent: contentEditable,
    canShare: (n) => n.ownerId === me.id,
    moveStartId: me.rootNodeId,
  });
  return (
    <>
      <FileView<FileNode>
        items={nodes}
        view={view}
        label={label}
        onOpen={actions.open}
        actionsFor={actions.actionsFor}
        badge={actions.badge}
        thumbSrc={(n) => (n.thumb === 'ready' ? thumbUrl(n.id, 256, n.updatedAt) : undefined)}
        subtitle={subtitle}
        // Same keyboard shortcuts as a folder for the items the menus let you change.
        onDelete={(ids) => {
          const set = new Set(ids);
          void actions.trashNodes(nodes.filter((n) => set.has(n.id) && editable(n)));
        }}
        onRename={(n) => editable(n) && actions.rename(n)}
        scrollPaddingTop={64}
      />
      {actions.dialogs}
      {previewIndex >= 0 && (
        <Suspense fallback={null}>
          <PreviewModal
            items={files}
            index={previewIndex}
            onIndexChange={(i) => setPreviewId(files[i]?.id ?? null)}
            onClose={() => setPreviewId(null)}
            source={{
              content: contentUrl,
              thumb: thumbUrl,
              stream: streamUrl,
              preview: previewUrl,
              canDownload: true,
            }}
          />
        </Suspense>
      )}
    </>
  );
}

export function SharedPage() {
  const shared = useSharedWithMe();
  const owners = useMemo(
    () =>
      new Map(
        shared.data?.items.map((i) => [
          i.node.id,
          `${i.owner.displayName} · ${i.permission === 'edit' ? 'can edit' : 'view only'}`,
        ]),
      ),
    [shared.data],
  );
  const editableIds = useMemo(
    () => new Set(shared.data?.items.filter((i) => i.permission === 'edit').map((i) => i.node.id)),
    [shared.data],
  );
  return (
    <>
      <PageTitle title="Shared with me" sections={{ label: 'Shared', items: SHARED_SECTIONS }} />
      <QueryState
        query={shared}
        loading={<FileViewSkeleton view="list" />}
        isEmpty={(d) => d.items.length === 0}
        empty={
          <EmptyState
            icon={<Users />}
            title="Nothing shared with you yet"
            description="When family members share folders or files with you, they show up here."
          />
        }
      >
        {(d) => (
          <FlatList
            nodes={d.items.map((i) => i.node)}
            label="Shared with me"
            subtitle={(n) => `Shared by ${owners.get(n.id) ?? ''}`}
            // The shared item itself lives in the owner's folder: it can't be renamed or moved
            // from here, but a file shared for editing can be saved over (and so has versions).
            editable={() => false}
            contentEditable={(n) => editableIds.has(n.id)}
          />
        )}
      </QueryState>
    </>
  );
}

/** "Shared by Mum" for things that belong to someone else. */
function useSharedBy() {
  const { me } = useShell();
  const directory = useDirectory();
  const names = useMemo(
    () => new Map(directory.data?.items.map((u) => [u.id, u.displayName])),
    [directory.data],
  );
  return (n: FileNode) =>
    n.ownerId === me.id ? '' : `Shared by ${names.get(n.ownerId) ?? 'someone else'}`;
}

export function RecentPage() {
  const recent = useRecent();
  const { me } = useShell();
  const sharedBy = useSharedBy();
  return (
    <>
      <PageTitle title="Recent" sections={{ label: 'Files', items: FILES_SECTIONS }} />
      <QueryState
        query={recent}
        loading={<FileViewSkeleton view="list" />}
        isEmpty={(d) => d.items.length === 0}
        empty={
          <EmptyState
            icon={<Clock />}
            title="Nothing here yet"
            description="Files you add or change, and files in folders shared with you, show up here."
          />
        }
      >
        {(d) => (
          <FlatList
            nodes={d.items}
            label="Recent files"
            subtitle={sharedBy}
            editable={(n) => n.ownerId === me.id}
          />
        )}
      </QueryState>
    </>
  );
}

export function StarredPage() {
  const starred = useStarred();
  const { me } = useShell();
  const sharedBy = useSharedBy();
  return (
    <>
      <PageTitle title="Starred" sections={{ label: 'Files', items: FILES_SECTIONS }} />
      <QueryState
        query={starred}
        loading={<FileViewSkeleton view="list" />}
        isEmpty={(d) => d.items.length === 0}
        empty={
          <EmptyState
            icon={<Star />}
            title="No starred items"
            description="Star files and folders you use often (from their menu) to find them here."
          />
        }
      >
        {(d) => (
          <FlatList
            nodes={d.items}
            label="Starred items"
            subtitle={sharedBy}
            editable={(n) => n.ownerId === me.id}
          />
        )}
      </QueryState>
    </>
  );
}

export function SearchPage() {
  const [params] = useSearchParams();
  const q = params.get('q') ?? '';
  const results = useSearch(q);
  const { me } = useShell();
  const sharedBy = useSharedBy();
  return (
    <>
      {/* Phones: the Search tab has no header search box, so it brings its own. */}
      <SearchBox id="tab-search" autoFocus={!q} className="mb-4 max-w-none md:hidden" />
      <PageTitle title={q ? `Results for “${q}”` : 'Search'} />
      {!q ? (
        <EmptyState
          icon={<Search />}
          title="Search your files"
          description="Type a name, or words in a document, in the search box. Files shared with you are searched too."
        />
      ) : (
        <QueryState
          query={results}
          loading={<FileViewSkeleton view="list" />}
          isEmpty={(d) => d.items.length === 0}
          empty={
            <EmptyState
              icon={<Search />}
              title="No matches"
              description="Try part of a name or a word in the file, like “beach” or “2024”."
            />
          }
        >
          {(d) => (
            <FlatList
              nodes={d.items}
              label={`Search results for ${q}`}
              // Found by what's in it: show where. Else who shared it, if it's not yours.
              subtitle={(n) => {
                const snippet = d.items.find((h) => h.id === n.id)?.snippet;
                return snippet ? `“…${snippet}…”` : sharedBy(n);
              }}
              // Things shared with you are found too; changing them is done from their folder.
              editable={(n) => n.ownerId === me.id}
            />
          )}
        </QueryState>
      )}
    </>
  );
}

export function TrashPage() {
  const trash = useTrash();
  const restore = useRestore();
  const purge = usePurge();
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState<{ id: string | 'all'; name: string } | null>(null);

  const doRestore = async (id: string, name: string) => {
    try {
      const res = await restore.mutateAsync(id);
      toast.success(`Restored “${res.node.name}”`, {
        action: res.node.parentId
          ? { label: 'Show', onClick: () => navigate(`/files/${res.node.parentId}`) }
          : undefined,
      });
    } catch (err) {
      toast.error(`${name}: ${errorMessage(err)}`);
    }
  };

  return (
    <>
      <PageTitle title="Trash" sections={{ label: 'Files', items: FILES_SECTIONS }}>
        {!!trash.data?.items.length && (
          <Button
            variant="danger"
            icon={<Trash2 size={16} />}
            onClick={() => setConfirm({ id: 'all', name: 'all items' })}
          >
            Empty trash
          </Button>
        )}
      </PageTitle>
      <QueryState
        query={trash}
        loading={<Skeleton className="h-40" />}
        isEmpty={(d) => d.items.length === 0}
        empty={
          <EmptyState
            icon={<Trash2 />}
            title="Trash is empty"
            description="Deleted items stay here for a while so you can restore them."
          />
        }
      >
        {(d) => (
          <>
            <p className="mb-3 text-sm text-muted">
              Items are deleted forever after {d.retentionDays} days. They still count toward your
              storage until then.
            </p>
            <ul className="divide-y divide-border rounded-2xl border border-border bg-surface">
              {d.items.map((item) => (
                // On a phone the buttons wrap under the name, which otherwise had room for a
                // few letters ("Blurry phot…").
                <li
                  key={item.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5"
                >
                  <FileIcon
                    node={item}
                    thumbSrc={item.thumb === 'ready' ? thumbUrl(item.id) : undefined}
                  />
                  <div className="min-w-0 flex-1 basis-48 [overflow-wrap:anywhere]">
                    <p className="line-clamp-2 text-sm font-medium">{item.name}</p>
                    <p className="line-clamp-2 text-xs text-muted">
                      Deleted {formatRelative(item.deletedAt)}
                      {item.originalParent ? ` from ${item.originalParent.name}` : ''} ·{' '}
                      {formatBytes(item.size)}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    icon={<RotateCcw size={14} />}
                    loading={restore.isPending && restore.variables === item.id}
                    onClick={() => void doRestore(item.id, item.name)}
                    className="ml-auto"
                  >
                    Restore
                  </Button>
                  <IconButton
                    label={`Delete ${item.name} forever`}
                    icon={<Trash2 />}
                    onClick={() => setConfirm({ id: item.id, name: item.name })}
                  />
                </li>
              ))}
            </ul>
          </>
        )}
      </QueryState>
      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        tone="danger"
        title={confirm?.id === 'all' ? 'Empty the trash?' : `Delete “${confirm?.name}” forever?`}
        description="This can't be undone. The space is freed immediately."
        confirmLabel="Delete forever"
        onConfirm={async () => {
          try {
            await purge.mutateAsync(confirm!.id);
            toast.success('Deleted forever');
          } catch (err) {
            toast.error(errorMessage(err));
            throw err;
          }
        }}
      />
    </>
  );
}
