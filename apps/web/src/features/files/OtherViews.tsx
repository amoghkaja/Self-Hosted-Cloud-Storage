import { type FileNode, formatBytes } from '@familycloud/shared';
import { RotateCcw, Search, Trash2, Users } from 'lucide-react';
import { lazy, Suspense, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { contentUrl, errorMessage, previewUrl, streamUrl, thumbUrl } from '../../api/client';
import { usePurge, useRestore, useSearch, useSharedWithMe, useTrash } from '../../api/queries';
import { useShell } from '../../app/guards';
import {
  Button,
  ConfirmDialog,
  EmptyState,
  IconButton,
  QueryState,
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

function PageTitle({ title, children }: { title: string; children?: React.ReactNode }) {
  usePageTitle(title);
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3">
      <h1 className="flex-1 text-xl font-semibold">{title}</h1>
      {children}
    </div>
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
        thumbSrc={(n) => (n.thumb === 'ready' ? thumbUrl(n.id) : undefined)}
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
      <PageTitle title="Shared with me" />
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

export function SearchPage() {
  const [params] = useSearchParams();
  const q = params.get('q') ?? '';
  const results = useSearch(q);
  return (
    <>
      <PageTitle title={q ? `Results for “${q}”` : 'Search'} />
      {!q ? (
        <EmptyState
          icon={<Search />}
          title="Search your files"
          description="Type a name in the search box above."
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
              description="Try part of the name, like “beach” or “2024”."
            />
          }
        >
          {(d) => (
            <FlatList nodes={d.items} label={`Search results for ${q}`} editable={() => true} />
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
      <PageTitle title="Trash">
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
                <li key={item.id} className="flex items-center gap-3 px-3 py-2.5">
                  <FileIcon
                    node={item}
                    thumbSrc={item.thumb === 'ready' ? thumbUrl(item.id) : undefined}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{item.name}</p>
                    <p className="truncate text-xs text-muted">
                      Deleted {formatRelative(item.deletedAt)}
                      {item.originalParent ? ` from ${item.originalParent.name}` : ''} ·{' '}
                      {formatBytes(item.size)}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    icon={<RotateCcw size={14} />}
                    onClick={() => void doRestore(item.id, item.name)}
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
