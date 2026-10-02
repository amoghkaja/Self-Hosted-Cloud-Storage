import type { FileNode } from '@familycloud/shared';
import { useQueryClient } from '@tanstack/react-query';
import {
  Copy,
  CopyPlus,
  Download,
  FolderInput,
  FolderOpen,
  History,
  Inbox,
  Pencil,
  Share2,
  ShieldAlert,
  Star,
  StarOff,
  Trash2,
} from 'lucide-react';
import { lazy, Suspense, useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { api, contentUrl, errorMessage, zipUrl } from '../../api/client';
import { type BatchResult, qk, useStarred, useToggleStar, useTrashNodes } from '../../api/queries';
import { type MenuAction, toast } from '../../components/ui';
import { MoveDialog, RenameDialog } from './dialogs';

// Opened on demand: kept out of the first page load.
const ShareDialog = lazy(() =>
  import('../sharing/ShareDialog').then((m) => ({ default: m.ShareDialog })),
);
const VersionsDialog = lazy(() =>
  import('./VersionsDialog').then((m) => ({ default: m.VersionsDialog })),
);

/** Starts a browser download without navigating away (the server sends Content-Disposition). */
export function triggerDownload(href: string) {
  const a = document.createElement('a');
  a.href = href;
  a.download = '';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function downloadNodes(nodes: Pick<FileNode, 'id' | 'type'>[]) {
  if (nodes.length === 1 && nodes[0]!.type === 'file') triggerDownload(contentUrl(nodes[0]!.id));
  else triggerDownload(zipUrl(nodes.map((n) => n.id)));
}

const CHECKING = 'This file is still being checked for viruses. Try again in a minute.';
const INFECTED = 'A virus was found in this file, so it is blocked. Delete it.';

type Dialog =
  | { kind: 'rename'; node: FileNode }
  | { kind: 'move'; nodes: FileNode[] }
  | { kind: 'copy'; nodes: FileNode[] }
  | { kind: 'share'; node: FileNode; request?: boolean }
  | { kind: 'versions'; node: FileNode }
  | null;

export interface FileActionOptions {
  onPreview: (node: FileNode) => void;
  /** Can the caller rename/move/trash items in this node's folder? */
  canEdit: (node: FileNode) => boolean;
  canShare: (node: FileNode) => boolean;
  /**
   * Can the caller change this file's contents (and so see its older versions)? Defaults to
   * canEdit; differs for a file shared on its own with edit rights.
   */
  canEditContent?: (node: FileNode) => boolean;
  /** Where the move picker starts (usually the owner's root). */
  moveStartId: string;
  /** Where the copy picker starts (the user's own My Files); defaults to moveStartId. */
  copyStartId?: string;
}

/**
 * One definition of what can be done to a file, reused by the kebab menu, right-click menu,
 * keyboard shortcuts and the multi-select bar, so they never drift apart.
 */
export function useFileActions(o: FileActionOptions) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const trash = useTrashNodes();
  const [dialog, setDialog] = useState<Dialog>(null);
  const starred = useStarred();
  const starredIds = useMemo(() => new Set(starred.data?.items.map((n) => n.id)), [starred.data]);
  const { mutate: setStar } = useToggleStar();

  const open = useCallback(
    (n: FileNode) => {
      if (n.infected) toast.error(INFECTED);
      else if (n.checking) toast.info(CHECKING);
      else if (n.type === 'folder') navigate(`/files/${n.id}`);
      else o.onPreview(n);
    },
    [navigate, o],
  );

  const { mutateAsync: trashMany } = trash;
  const trashNodes = useCallback(
    async (nodes: FileNode[]) => {
      if (nodes.length === 0) return;
      let result: BatchResult;
      try {
        result = await trashMany({ items: nodes.map((n) => ({ id: n.id, parentId: n.parentId })) });
      } catch (err) {
        toast.error(errorMessage(err));
        return;
      }
      const trashed = nodes.filter((n) => result.done.includes(n.id));
      if (result.failed.length) {
        const first = errorMessage(result.failed[0]!.error);
        toast.error(
          nodes.length === 1
            ? first
            : `${result.failed.length} of ${nodes.length} items weren't moved to trash: ${first}`,
        );
      }
      if (trashed.length === 0) return;
      toast.success(
        trashed.length === 1
          ? `Moved “${trashed[0]!.name}” to trash`
          : `Moved ${trashed.length} items to trash`,
        {
          action: {
            label: 'Undo',
            onClick: async () => {
              let failed = 0;
              for (const n of trashed) {
                await api(`/trash/${n.id}/restore`, { method: 'POST', json: {} }).catch(() => {
                  failed++;
                });
              }
              for (const parentId of new Set(trashed.map((n) => n.parentId))) {
                if (parentId) void qc.invalidateQueries({ queryKey: qk.children(parentId) });
              }
              void qc.invalidateQueries({ queryKey: qk.trash });
              void qc.invalidateQueries({ queryKey: qk.searches });
              if (failed)
                toast.error(`${failed} item${failed === 1 ? '' : 's'} couldn't be restored`);
            },
          },
        },
      );
    },
    [trashMany, qc],
  );

  const makeCopy = useCallback(
    async (n: FileNode) => {
      if (!n.parentId) return;
      try {
        const copy = await api<FileNode>(`/nodes/${n.id}/copy`, { json: { parentId: n.parentId } });
        void qc.invalidateQueries({ queryKey: qk.children(n.parentId) });
        void qc.invalidateQueries({ queryKey: qk.me });
        toast.success(`Made “${copy.name}”`);
      } catch (err) {
        toast.error(errorMessage(err));
      }
    },
    [qc],
  );

  const actionsFor = useCallback(
    (n: FileNode): MenuAction[] => {
      const edit = o.canEdit(n);
      const list: MenuAction[] = [
        {
          id: 'open',
          label: n.type === 'folder' ? 'Open' : 'Preview',
          icon: <FolderOpen />,
          shortcut: 'Enter',
          onSelect: () => open(n),
        },
        {
          id: 'download',
          label: n.type === 'folder' ? 'Download as zip' : 'Download',
          icon: <Download />,
          onSelect: () =>
            n.infected
              ? toast.error(INFECTED)
              : n.checking
                ? toast.info(CHECKING)
                : downloadNodes([n]),
        },
        {
          id: 'star',
          label: starredIds.has(n.id) ? 'Remove from Starred' : 'Add to Starred',
          icon: starredIds.has(n.id) ? <StarOff /> : <Star />,
          onSelect: () =>
            setStar(
              { node: n, starred: !starredIds.has(n.id) },
              { onError: (err) => toast.error(errorMessage(err)) },
            ),
        },
      ];
      if (o.canShare(n)) {
        list.push({
          id: 'share',
          label: 'Share…',
          icon: <Share2 />,
          onSelect: () => setDialog({ kind: 'share', node: n }),
        });
        if (n.type === 'folder') {
          list.push({
            id: 'request',
            label: 'Request files…',
            icon: <Inbox />,
            onSelect: () => setDialog({ kind: 'share', node: n, request: true }),
          });
        }
      }
      if (n.type === 'file' && (o.canEditContent ?? o.canEdit)(n)) {
        list.push({
          id: 'versions',
          label: 'Version history…',
          icon: <History />,
          onSelect: () => setDialog({ kind: 'versions', node: n }),
        });
      }
      if (edit) {
        list.push(
          {
            id: 'rename',
            label: 'Rename…',
            icon: <Pencil />,
            shortcut: 'F2',
            separatorBefore: true,
            onSelect: () => setDialog({ kind: 'rename', node: n }),
          },
          {
            id: 'duplicate',
            label: 'Make a copy',
            icon: <CopyPlus />,
            onSelect: () => void makeCopy(n),
          },
        );
      }
      // Anything you can see you can copy into your own files (like downloading it).
      list.push({
        id: 'copy',
        label: 'Copy to…',
        icon: <Copy />,
        separatorBefore: !edit,
        onSelect: () => setDialog({ kind: 'copy', nodes: [n] }),
      });
      if (edit) {
        list.push(
          {
            id: 'move',
            label: 'Move…',
            icon: <FolderInput />,
            onSelect: () => setDialog({ kind: 'move', nodes: [n] }),
          },
          {
            id: 'trash',
            label: 'Move to trash',
            icon: <Trash2 />,
            tone: 'danger',
            shortcut: 'Del',
            onSelect: () => void trashNodes([n]),
          },
        );
      }
      return list;
    },
    [o, open, trashNodes, makeCopy, starredIds, setStar],
  );

  /** A star beside the names of starred items. */
  const badge = useCallback(
    (n: FileNode) =>
      n.infected ? (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-danger-soft px-1.5 py-0.5 text-xs font-medium text-danger">
          <ShieldAlert className="size-3.5" aria-hidden />
          Virus found
        </span>
      ) : n.checking ? (
        <span className="inline-flex shrink-0 items-center rounded-md bg-surface-2 px-1.5 py-0.5 text-xs font-medium text-muted">
          Being checked
        </span>
      ) : starredIds.has(n.id) ? (
        <Star
          role="img"
          aria-label="Starred"
          className="size-3.5 shrink-0 fill-current text-brass"
        />
      ) : null,
    [starredIds],
  );

  const dialogs = (
    <>
      {dialog?.kind === 'rename' && (
        <RenameDialog
          node={dialog.node}
          parentId={dialog.node.parentId!}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'move' && (
        <MoveDialog
          nodes={dialog.nodes}
          fromParentId={dialog.nodes[0]!.parentId!}
          startFolderId={o.moveStartId}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'copy' && (
        <MoveDialog
          mode="copy"
          nodes={dialog.nodes}
          fromParentId={dialog.nodes[0]!.parentId!}
          startFolderId={o.copyStartId ?? o.moveStartId}
          onClose={() => setDialog(null)}
        />
      )}
      <Suspense fallback={null}>
        {dialog?.kind === 'share' && (
          <ShareDialog
            node={dialog.node}
            initialTab={dialog.request ? 'request' : 'family'}
            onClose={() => setDialog(null)}
          />
        )}
        {dialog?.kind === 'versions' && (
          <VersionsDialog node={dialog.node} onClose={() => setDialog(null)} />
        )}
      </Suspense>
    </>
  );

  return {
    open,
    trashNodes,
    actionsFor,
    badge,
    dialogs,
    rename: (n: FileNode) => setDialog({ kind: 'rename', node: n }),
    move: (nodes: FileNode[]) => setDialog({ kind: 'move', nodes }),
    copy: (nodes: FileNode[]) => setDialog({ kind: 'copy', nodes }),
  };
}
