import type { FileNode, SortDir, SortKey } from '@familycloud/shared';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowUpDown,
  Download,
  FolderInput,
  FolderPlus,
  FolderUp,
  LayoutGrid,
  List,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { contentUrl, thumbUrl } from '../../api/client';
import { qk, useChildren, useNode } from '../../api/queries';
import { useShell } from '../../app/guards';
import { uploadManager } from '../../app/providers';
import {
  Breadcrumbs,
  Button,
  collectDroppedFiles,
  DropdownMenu,
  DropZone,
  EmptyState,
  ErrorState,
  filesFromInput,
  IconButton,
  QueryState,
  Skeleton,
  Tooltip,
} from '../../components/ui';
import { usePref } from '../../lib/storage';
import { downloadNodes, useFileActions } from './actions';
import { NewFolderDialog } from './dialogs';
import { FileView, FileViewSkeleton } from './FileView';

const PreviewModal = lazy(() => import('./PreviewModal'));

export function FilesPage() {
  const { folderId } = useParams();
  const { me } = useShell();
  const id = folderId ?? me.rootNodeId;
  // Remount per folder so selection, focus and scroll start fresh.
  return <FileBrowser key={id} folderId={id} />;
}

const SORT_LABELS: Record<SortKey, string> = {
  name: 'Name',
  updated: 'Last modified',
  size: 'Size',
};

function FileBrowser({ folderId }: { folderId: string }) {
  const { me } = useShell();
  const qc = useQueryClient();
  const detail = useNode(folderId);
  const [view, setView] = usePref<'list' | 'grid'>('view', 'list');
  const [sort, setSort] = usePref<{ key: SortKey; dir: SortDir }>('sort', {
    key: 'name',
    dir: 'asc',
  });
  const children = useChildren(folderId, sort.key, sort.dir);
  const items = useMemo(() => children.data?.pages.flatMap((p) => p.items) ?? [], [children.data]);
  const files = useMemo(() => items.filter((n) => n.type === 'file'), [items]);
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [resetKey, setResetKey] = useState(0);
  const [preview, setPreview] = useState<number | null>(null);
  const [newFolder, setNewFolder] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const access = detail.data?.access;
  const canEdit = access === 'owner' || access === 'edit';
  const actions = useFileActions({
    onPreview: (n) => setPreview(files.findIndex((f) => f.id === n.id)),
    canEdit: () => canEdit,
    canShare: () => access === 'owner',
    moveStartId: detail.data?.breadcrumbs[0]?.id ?? me.rootNodeId,
  });

  const name = detail.data ? (detail.data.isRoot ? 'My Files' : detail.data.node.name) : '';
  useEffect(() => {
    if (name) document.title = `${name} · Family Cloud`;
  }, [name]);

  // Thumbnails are rendered in the background after upload: refresh until they're ready.
  const pendingThumbs = items.some((n) => n.thumb === 'pending');
  const polls = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `items` re-arms the poll after each refresh
  useEffect(() => {
    if (!pendingThumbs || polls.current > 15) return;
    const t = setTimeout(() => {
      polls.current++;
      void qc.invalidateQueries({ queryKey: qk.children(folderId) });
    }, 4000);
    return () => clearTimeout(t);
  }, [pendingThumbs, folderId, qc, items]);

  const selectedNodes = items.filter((n) => selection.has(n.id));
  const clearSelection = useCallback(() => setResetKey((k) => k + 1), []);
  const upload = (picked: { file: File; relativeDir: string }[]) => {
    if (picked.length) uploadManager.add(folderId, picked);
  };

  if (detail.isError) {
    return (
      <ErrorState
        title="Folder not found"
        error="It may have been deleted, or it isn't shared with you."
      />
    );
  }

  const crumbs = (detail.data?.breadcrumbs ?? []).map((b, i, arr) => ({
    key: b.id,
    label: i === 0 && detail.data?.access === 'owner' ? 'My Files' : b.name,
    to: i < arr.length - 1 ? `/files/${b.id}` : undefined,
  }));

  return (
    <DropZone
      disabled={!canEdit}
      label={`Drop to upload to ${name || 'this folder'}`}
      onDrop={async (dt) => upload(await collectDroppedFiles(dt))}
      className="min-h-[60vh]"
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          {detail.data ? <Breadcrumbs items={crumbs} /> : <Skeleton className="h-7 w-48" />}
          {access && access !== 'owner' && (
            <p className="px-1.5 text-xs text-muted">
              {access === 'edit' ? 'Shared with you · can edit' : 'Shared with you · view only'}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1">
          {canEdit && (
            <>
              <Tooltip content="New folder">
                <Button
                  icon={<FolderPlus size={16} />}
                  onClick={() => setNewFolder(true)}
                  aria-label="New folder"
                >
                  <span className="hidden sm:inline">New folder</span>
                </Button>
              </Tooltip>
              <DropdownMenu
                label="Upload"
                trigger={
                  <Button variant="primary" icon={<Upload size={16} />}>
                    Upload
                  </Button>
                }
                actions={[
                  {
                    id: 'files',
                    label: 'Files',
                    icon: <Upload />,
                    onSelect: () => fileInput.current?.click(),
                  },
                  {
                    id: 'folder',
                    label: 'Folder',
                    icon: <FolderUp />,
                    onSelect: () => folderInput.current?.click(),
                  },
                ]}
              />
            </>
          )}
          <DropdownMenu
            label="Sort"
            trigger={
              <IconButton
                label={`Sort by ${SORT_LABELS[sort.key].toLowerCase()}`}
                icon={<ArrowUpDown />}
                noTooltip
              />
            }
            actions={(['name', 'updated', 'size'] as SortKey[]).flatMap((k) =>
              (['asc', 'desc'] as SortDir[]).map((d) => ({
                id: `${k}-${d}`,
                label: `${SORT_LABELS[k]} ${k === 'name' ? (d === 'asc' ? 'A→Z' : 'Z→A') : d === 'asc' ? '(smallest/oldest first)' : '(largest/newest first)'}`,
                icon: sort.key === k && sort.dir === d ? <span>✓</span> : <span />,
                onSelect: () => setSort({ key: k, dir: d }),
              })),
            )}
          />
          <IconButton
            label={view === 'list' ? 'Show as grid' : 'Show as list'}
            icon={view === 'list' ? <LayoutGrid /> : <List />}
            onClick={() => setView(view === 'list' ? 'grid' : 'list')}
          />
        </div>
      </div>

      {selectedNodes.length > 0 && (
        <div
          role="toolbar"
          aria-label="Selection actions"
          className="sticky top-16 z-20 mb-2 flex items-center gap-1 rounded-xl border border-accent/30 bg-accent-soft px-2 py-1.5 animate-fade-in"
        >
          <IconButton size="sm" label="Clear selection" icon={<X />} onClick={clearSelection} />
          <span className="flex-1 text-sm font-medium">{selectedNodes.length} selected</span>
          <IconButton
            size="sm"
            label="Download selected"
            icon={<Download />}
            onClick={() => downloadNodes(selectedNodes)}
          />
          {canEdit && (
            <>
              <IconButton
                size="sm"
                label="Move selected"
                icon={<FolderInput />}
                onClick={() => actions.move(selectedNodes)}
              />
              <IconButton
                size="sm"
                label="Move selected to trash"
                icon={<Trash2 />}
                onClick={() => void actions.trashNodes(selectedNodes)}
              />
            </>
          )}
        </div>
      )}

      <QueryState
        query={children}
        loading={<FileViewSkeleton view={view} />}
        isEmpty={() => items.length === 0}
        empty={
          <EmptyState
            icon={<FolderUp />}
            title="This folder is empty"
            description={
              canEdit
                ? 'Drag files here, or use Upload. You can upload whole folders too.'
                : 'Nothing has been added here yet.'
            }
            action={
              canEdit && (
                <Button
                  variant="primary"
                  icon={<Upload size={16} />}
                  onClick={() => fileInput.current?.click()}
                >
                  Upload files
                </Button>
              )
            }
          />
        }
      >
        {() => (
          <FileView<FileNode>
            items={items}
            view={view}
            label={`Contents of ${name}`}
            onOpen={actions.open}
            actionsFor={actions.actionsFor}
            thumbSrc={(n) => (n.thumb === 'ready' ? thumbUrl(n.id, 256) : undefined)}
            onDelete={
              canEdit
                ? (ids) => void actions.trashNodes(items.filter((n) => ids.includes(n.id)))
                : undefined
            }
            onRename={canEdit ? actions.rename : undefined}
            onSelectionChange={setSelection}
            selectionResetKey={resetKey}
            sort={{ key: sort.key, dir: sort.dir, onChange: (key, dir) => setSort({ key, dir }) }}
            hasMore={children.hasNextPage}
            loadingMore={children.isFetchingNextPage}
            onLoadMore={() => void children.fetchNextPage()}
          />
        )}
      </QueryState>

      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) upload(filesFromInput(e.target.files));
          e.target.value = '';
        }}
      />
      <input
        ref={folderInput}
        type="file"
        multiple
        hidden
        {...({ webkitdirectory: '' } as Record<string, string>)}
        onChange={(e) => {
          if (e.target.files) upload(filesFromInput(e.target.files));
          e.target.value = '';
        }}
      />
      {newFolder && <NewFolderDialog parentId={folderId} open onOpenChange={setNewFolder} />}
      {actions.dialogs}
      {preview !== null && preview >= 0 && (
        <Suspense fallback={null}>
          <PreviewModal
            items={files}
            index={preview}
            onIndexChange={setPreview}
            onClose={() => setPreview(null)}
            source={{ content: contentUrl, thumb: thumbUrl, canDownload: true }}
          />
        </Suspense>
      )}
    </DropZone>
  );
}
