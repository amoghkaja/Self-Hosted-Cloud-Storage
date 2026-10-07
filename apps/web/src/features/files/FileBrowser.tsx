import {
  type FileNode,
  type NameCheckResult,
  nameProblem,
  normalizeName,
  type SortDir,
  type SortKey,
} from '@familycloud/shared';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowUpDown,
  Copy,
  Download,
  FolderInput,
  FolderPlus,
  FolderUp,
  History,
  Inbox,
  LayoutGrid,
  List,
  Lock,
  Trash2,
  Upload,
  Users,
  X,
} from 'lucide-react';
import {
  type CSSProperties,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Link, useParams } from 'react-router';
import {
  ApiError,
  api,
  contentUrl,
  errorMessage,
  previewUrl,
  streamUrl,
  thumbUrl,
} from '../../api/client';
import { qk, useChildren, useNode } from '../../api/queries';
import { useShell } from '../../app/guards';
import { uploadManager } from '../../app/providers';
import { FILES_SECTIONS } from '../../app/sections';
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
  type PickedFile,
  QueryState,
  SectionLinks,
  Skeleton,
  Tooltip,
  toast,
} from '../../components/ui';
import { usePref } from '../../lib/storage';
import { usePageTitle } from '../../lib/usePageTitle';
import { RequestFilesDialog } from '../sharing/RequestFilesDialog';
import { ReplaceDialog } from '../uploads/ReplaceDialog';
import { downloadNodes, useFileActions } from './actions';
import { NewFolderDialog } from './dialogs';
import { FileView, FileViewSkeleton } from './FileView';
import { RewindDialog } from './RewindDialog';

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
const SORT_DIRS: Record<SortKey, Record<SortDir, string>> = {
  name: { asc: 'A→Z', desc: 'Z→A' },
  updated: { asc: 'oldest first', desc: 'newest first' },
  size: { asc: 'smallest first', desc: 'largest first' },
};

/** The app header (h-16) is sticky; the selection toolbar sticks right below it. */
const HEADER_HEIGHT = 64;
const TOOLBAR_HEIGHT = 52;

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
  // By id, not index: the listing can refresh underneath an open preview (uploads landing,
  // thumbnails finishing) and an index would then point at a different file.
  const [previewId, setPreviewId] = useState<string | null>(null);
  const previewIndex = previewId ? files.findIndex((f) => f.id === previewId) : -1;
  const [newFolder, setNewFolder] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [rewinding, setRewinding] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const access = detail.data?.access;
  const canEdit = access === 'owner' || access === 'edit';
  const actions = useFileActions({
    onPreview: (n) => setPreviewId(n.id),
    canEdit: () => canEdit,
    canShare: () => access === 'owner',
    moveStartId: detail.data?.breadcrumbs[0]?.id ?? me.rootNodeId,
    copyStartId: me.rootNodeId,
  });

  const name = detail.data ? (detail.data.isRoot ? 'My Files' : detail.data.node.name) : '';
  usePageTitle(name || null);

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
  const selecting = selectedNodes.length > 0;
  // While items are selected, the selection toolbar takes the place of the folder header at the
  // same height. Inserting it above the list instead pushed every row down between the two
  // clicks of a double-click, so the second click landed on a different row.
  const headerRef = useRef<HTMLDivElement>(null);
  const [headerHeight, setHeaderHeight] = useState(0);
  useLayoutEffect(() => {
    if (!selecting && headerRef.current) setHeaderHeight(headerRef.current.offsetHeight);
  });
  // The selection toolbar disappears with the selection. Move focus to the list's current item
  // first, so it doesn't fall to the top of the page along with the button that had it.
  const focusList = () =>
    listRef.current
      ?.querySelector<HTMLElement>('[role="grid"] [tabindex="0"]')
      ?.focus({ preventScroll: true });
  const clearSelection = useCallback(() => setResetKey((k) => k + 1), []);
  const [conflict, setConflict] = useState<{
    picked: PickedFile[];
    names: string[];
    retentionDays: number;
  } | null>(null);
  /** Files picked straight into this folder whose names are taken: ask replace or keep both. */
  const upload = async (picked: PickedFile[]) => {
    if (!picked.length) return;
    const names = [
      ...new Set(
        picked
          .filter((p) => !p.relativeDir)
          .map((p) => normalizeName(p.file.name))
          .filter((n) => !nameProblem(n)),
      ),
    ].slice(0, 1000);
    const taken = names.length
      ? await api<NameCheckResult>(`/nodes/${folderId}/name-check`, { json: { names } }).catch(
          () => null, // can't ask: upload alongside, as before
        )
      : null;
    if (taken?.files.length) {
      setConflict({ picked, names: taken.files, retentionDays: taken.versionRetentionDays });
      return;
    }
    uploadManager.add(folderId, picked);
  };
  const resolveConflict = (replace: boolean) => {
    if (!conflict) return;
    const taken = new Set(conflict.names.map((n) => n.toLowerCase()));
    uploadManager.add(
      folderId,
      conflict.picked.map((p) => ({
        ...p,
        replace: replace && !p.relativeDir && taken.has(normalizeName(p.file.name).toLowerCase()),
      })),
    );
    setConflict(null);
  };

  if (detail.isError) {
    const missing = detail.error instanceof ApiError && detail.error.status === 404;
    return missing ? (
      <ErrorState
        title="Folder not found"
        error="It may have been deleted, or it isn't shared with you."
      />
    ) : (
      <ErrorState
        title="Couldn't open this folder"
        error={detail.error}
        onRetry={() => void detail.refetch()}
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
      onDrop={(dt) =>
        collectDroppedFiles(dt).then(
          ({ files, emptyFolders }) => {
            if (emptyFolders.length) {
              uploadManager
                .addFolders(folderId, emptyFolders)
                .catch((err) => toast.error(`Couldn't make a folder: ${errorMessage(err)}`));
            }
            return upload(files);
          },
          (err) => toast.error(`Couldn't read the dropped files: ${errorMessage(err)}`),
        )
      }
      className="min-h-[60vh]"
      // Dialogs opened from the selection toolbar (Move) return focus to the list, since the
      // toolbar is gone by the time they close.
      data-focus-fallback=""
    >
      {/* The breadcrumbs show where you are; screen-reader users also get it as the page heading. */}
      {name && <h1 className="sr-only">{name}</h1>}
      {folderId === me.rootNodeId && !selecting && (
        <SectionLinks label="Files" items={FILES_SECTIONS} />
      )}
      <div ref={headerRef} hidden={selecting} className="mb-3 flex flex-wrap items-center gap-2">
        {/* Full width on phones, so the current folder's name isn't squeezed to "Ph…". */}
        <div className="min-w-0 basis-full sm:flex-1 sm:basis-0">
          {detail.data ? <Breadcrumbs items={crumbs} /> : <Skeleton className="h-7 w-48" />}
          {access && access !== 'owner' && (
            <p className="px-1.5 text-xs text-muted">
              {access === 'edit' ? 'Shared with you · can edit' : 'Shared with you · view only'}
            </p>
          )}
          {access === 'owner' && !detail.data?.album && (
            <p className="flex items-center gap-1.5 px-1.5 text-xs text-muted">
              <Lock size={12} aria-hidden />
              Private: only you can see these, unless you share them.
            </p>
          )}
        </div>
        <div className="ml-auto flex items-center gap-1">
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
              {access === 'owner' && !detail.data?.album && (
                <Button icon={<Inbox size={16} />} onClick={() => setRequesting(true)}>
                  <span className="sm:hidden">Request</span>
                  <span className="hidden sm:inline">Request files</span>
                </Button>
              )}
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
          {access === 'owner' && (
            <IconButton
              label="Rewind this folder"
              icon={<History />}
              onClick={() => setRewinding(true)}
            />
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
                label: `${SORT_LABELS[k]}, ${SORT_DIRS[k][d]}`,
                checked: sort.key === k && sort.dir === d,
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

      {detail.data?.album && (
        <p className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-accent/30 bg-accent-soft px-3 py-2 text-sm">
          <Users size={16} aria-hidden className="shrink-0 text-accent" />
          <span className="min-w-0 flex-1">
            Photos here are part of the family album “{detail.data.album.title}”. The whole family
            can see them.
          </span>
          <Link
            to={`/photos/${detail.data.album.id}`}
            className="font-medium text-accent underline-offset-2 hover:underline"
          >
            Open album
          </Link>
        </p>
      )}

      {selecting && (
        <div
          role="toolbar"
          aria-label="Selection actions"
          // Phones wrap the header onto two lines; there's no double-click to protect there.
          style={{ '--header-h': `${headerHeight}px` } as CSSProperties}
          className="sticky top-16 z-20 mb-3 flex items-center gap-1 rounded-xl border border-accent/30 bg-accent-soft px-2 py-1 animate-fade-in sm:min-h-[var(--header-h)]"
        >
          <IconButton
            size="sm"
            label="Clear selection"
            icon={<X />}
            onClick={() => {
              focusList();
              clearSelection();
            }}
          />
          <span className="flex-1 text-sm font-medium">{selectedNodes.length} selected</span>
          <IconButton
            size="sm"
            label="Download selected"
            icon={<Download />}
            onClick={() => downloadNodes(selectedNodes)}
          />
          <IconButton
            size="sm"
            label="Copy selected to…"
            icon={<Copy />}
            onClick={() => actions.copy(selectedNodes)}
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
                onClick={() => {
                  focusList();
                  void actions.trashNodes(selectedNodes);
                }}
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
          <div ref={listRef}>
            <FileView<FileNode>
              items={items}
              view={view}
              label={`Contents of ${name}`}
              onOpen={actions.open}
              actionsFor={actions.actionsFor}
              badge={actions.badge}
              thumbSrc={(n) => (n.thumb === 'ready' ? thumbUrl(n.id, 256, n.updatedAt) : undefined)}
              onDelete={
                canEdit
                  ? (ids) => {
                      const set = new Set(ids);
                      void actions.trashNodes(items.filter((n) => set.has(n.id)));
                    }
                  : undefined
              }
              onRename={canEdit ? actions.rename : undefined}
              onSelectionChange={setSelection}
              selectionResetKey={resetKey}
              sort={{ key: sort.key, dir: sort.dir, onChange: (key, dir) => setSort({ key, dir }) }}
              // While a new sort order loads, the old list stays up; don't page through it.
              hasMore={children.hasNextPage && !children.isPlaceholderData}
              loadingMore={children.isFetchingNextPage}
              onLoadMore={() => void children.fetchNextPage()}
              scrollPaddingTop={HEADER_HEIGHT + (selecting ? TOOLBAR_HEIGHT : 0)}
            />
          </div>
        )}
      </QueryState>

      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) void upload(filesFromInput(e.target.files));
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
          if (e.target.files) void upload(filesFromInput(e.target.files));
          e.target.value = '';
        }}
      />
      {newFolder && <NewFolderDialog parentId={folderId} open onOpenChange={setNewFolder} />}
      {requesting && (
        <RequestFilesDialog parentId={folderId} onClose={() => setRequesting(false)} />
      )}
      {rewinding && (
        <RewindDialog folder={{ id: folderId, name }} onClose={() => setRewinding(false)} />
      )}
      {conflict && (
        <ReplaceDialog
          names={conflict.names}
          folderName={name || 'this folder'}
          retentionDays={conflict.retentionDays}
          onChoose={resolveConflict}
          onCancel={() => setConflict(null)}
        />
      )}
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
    </DropZone>
  );
}
