import type { FileNode } from '@familycloud/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Download, FolderInput, FolderOpen, Pencil, Share2, Trash2 } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router';
import { api, contentUrl, errorMessage, zipUrl } from '../../api/client';
import { type BatchResult, qk, useTrashNodes } from '../../api/queries';
import { type MenuAction, toast } from '../../components/ui';
import { ShareDialog } from '../sharing/ShareDialog';
import { MoveDialog, RenameDialog } from './dialogs';

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

type Dialog =
  | { kind: 'rename'; node: FileNode }
  | { kind: 'move'; nodes: FileNode[] }
  | { kind: 'share'; node: FileNode }
  | null;

export interface FileActionOptions {
  onPreview: (node: FileNode) => void;
  /** Can the caller rename/move/trash items in this node's folder? */
  canEdit: (node: FileNode) => boolean;
  canShare: (node: FileNode) => boolean;
  /** Where the move picker starts (usually the owner's root). */
  moveStartId: string;
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

  const open = useCallback(
    (n: FileNode) => (n.type === 'folder' ? navigate(`/files/${n.id}`) : o.onPreview(n)),
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
          onSelect: () => downloadNodes([n]),
        },
      ];
      if (o.canShare(n)) {
        list.push({
          id: 'share',
          label: 'Share…',
          icon: <Share2 />,
          onSelect: () => setDialog({ kind: 'share', node: n }),
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
    [o, open, trashNodes],
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
      {dialog?.kind === 'share' && (
        <ShareDialog node={dialog.node} onClose={() => setDialog(null)} />
      )}
    </>
  );

  return {
    open,
    trashNodes,
    actionsFor,
    dialogs,
    rename: (n: FileNode) => setDialog({ kind: 'rename', node: n }),
    move: (nodes: FileNode[]) => setDialog({ kind: 'move', nodes }),
  };
}
