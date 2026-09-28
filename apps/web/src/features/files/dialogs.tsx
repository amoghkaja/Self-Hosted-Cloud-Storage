import { type FileNode, nameProblem, normalizeName, splitExtension } from '@familycloud/shared';
import { ChevronRight, Folder } from 'lucide-react';
import { type FormEvent, Fragment, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../api/client';
import {
  useChildren,
  useCreateFolder,
  useMoveNodes,
  useNode,
  useUpdateNode,
} from '../../api/queries';
import {
  Button,
  Dialog,
  EmptyState,
  QueryState,
  Skeleton,
  TextField,
  toast,
} from '../../components/ui';

function useNameField(initial: string) {
  const [value, setValue] = useState(initial);
  const [touched, setTouched] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const normalized = normalizeName(value);
  const problem = nameProblem(normalized);
  return {
    value,
    normalized,
    problem,
    error: serverError ?? (touched ? problem : null),
    setValue: (v: string) => {
      setValue(v);
      setServerError(null);
    },
    touch: () => setTouched(true),
    setServerError,
  };
}

export function NewFolderDialog({
  parentId,
  open,
  onOpenChange,
}: {
  parentId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const create = useCreateFolder();
  const name = useNameField('New folder');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    name.touch();
    if (name.problem) return;
    try {
      await create.mutateAsync({ parentId, name: name.normalized });
      toast.success(`Created “${name.normalized}”`);
      onOpenChange(false);
    } catch (err) {
      name.setServerError(errorMessage(err));
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New folder"
      size="sm"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="new-folder" loading={create.isPending}>
            Create
          </Button>
        </>
      }
    >
      <form id="new-folder" onSubmit={submit}>
        <TextField
          label="Folder name"
          value={name.value}
          onChange={(e) => name.setValue(e.target.value)}
          onBlur={name.touch}
          error={name.error}
          onFocus={(e) => e.currentTarget.select()}
          autoFocus
        />
      </form>
    </Dialog>
  );
}

export function RenameDialog({
  node,
  parentId,
  onClose,
}: {
  node: Pick<FileNode, 'id' | 'name' | 'type'>;
  parentId: string;
  onClose: () => void;
}) {
  const update = useUpdateNode();
  const name = useNameField(node.name);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Select just the base name so typing keeps the extension ("photo|.jpg").
    const el = input.current;
    if (!el) return;
    const base = node.type === 'file' ? splitExtension(node.name)[0].length : node.name.length;
    requestAnimationFrame(() => el.setSelectionRange(0, base));
  }, [node]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    name.touch();
    if (name.problem) return;
    if (name.normalized === node.name) return onClose();
    try {
      await update.mutateAsync({ id: node.id, name: name.normalized, fromParentId: parentId });
      onClose();
    } catch (err) {
      name.setServerError(errorMessage(err));
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Rename"
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="rename" loading={update.isPending}>
            Rename
          </Button>
        </>
      }
    >
      <form id="rename" onSubmit={submit}>
        <TextField
          ref={input}
          label="Name"
          value={name.value}
          onChange={(e) => name.setValue(e.target.value)}
          error={name.error}
          autoFocus
        />
      </form>
    </Dialog>
  );
}

/** Folder picker for moving items within the same person's files. */
export function MoveDialog({
  nodes,
  fromParentId,
  startFolderId,
  onClose,
}: {
  nodes: Pick<FileNode, 'id' | 'name' | 'type'>[];
  fromParentId: string;
  startFolderId: string;
  onClose: () => void;
}) {
  const [folderId, setFolderId] = useState(startFolderId);
  const detail = useNode(folderId);
  const children = useChildren(folderId, 'name', 'asc');
  const moveNodes = useMoveNodes();
  const moving = new Set(nodes.map((n) => n.id));
  const folders = (children.data?.pages.flatMap((p) => p.items) ?? []).filter(
    (n) => n.type === 'folder',
  );
  // Only once we know the destination and that we may add to it.
  const canMoveHere =
    folderId !== fromParentId &&
    !moving.has(folderId) &&
    !!detail.data &&
    detail.data.access !== 'view';

  const move = async () => {
    let result: Awaited<ReturnType<typeof moveNodes.mutateAsync>>;
    try {
      result = await moveNodes.mutateAsync({
        ids: nodes.map((n) => n.id),
        parentId: folderId,
        fromParentId,
      });
    } catch (err) {
      toast.error(errorMessage(err));
      return;
    }
    for (const f of result.failed) {
      const name = nodes.find((n) => n.id === f.id)?.name ?? 'Item';
      toast.error(`${name}: ${errorMessage(f.error)}`);
    }
    if (result.failed.length === 0) {
      toast.success(
        nodes.length === 1 ? `Moved “${nodes[0]!.name}”` : `Moved ${nodes.length} items`,
      );
      onClose();
    }
  };

  const title = nodes.length === 1 ? `Move “${nodes[0]!.name}”` : `Move ${nodes.length} items`;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={title}
      description="Choose a destination folder."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={move}
            loading={moveNodes.isPending}
            disabled={!canMoveHere}
          >
            Move here
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {detail.data && (
          <nav aria-label="Destination path" className="flex flex-wrap items-center gap-1 text-sm">
            {detail.data.breadcrumbs.map((b, i, arr) => (
              <Fragment key={b.id}>
                {i > 0 && <ChevronRight size={14} className="text-muted" aria-hidden />}
                {i === arr.length - 1 ? (
                  <span aria-current="location" className="px-1 font-semibold">
                    {b.name}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setFolderId(b.id)}
                    className="rounded px-1 text-accent hover:underline"
                  >
                    {b.name}
                  </button>
                )}
              </Fragment>
            ))}
          </nav>
        )}
        <QueryState
          query={children}
          loading={<Skeleton className="h-40" />}
          isEmpty={() => folders.length === 0}
          empty={
            <EmptyState
              icon={<Folder />}
              title="No folders here"
              description="You can still move items into this folder."
              className="py-8"
            />
          }
        >
          {() => (
            <ul className="max-h-72 overflow-y-auto rounded-xl border border-border">
              {folders.map((f) => {
                const disabled = moving.has(f.id);
                return (
                  <li key={f.id}>
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => setFolderId(f.id)}
                      className="flex h-11 w-full items-center gap-3 px-3 text-left text-sm hover:bg-surface-2 disabled:opacity-40"
                    >
                      <Folder size={18} className="text-accent" aria-hidden />
                      <span className="flex-1 truncate">{f.name}</span>
                      <ChevronRight size={16} className="text-muted" aria-hidden />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </QueryState>
      </div>
    </Dialog>
  );
}
