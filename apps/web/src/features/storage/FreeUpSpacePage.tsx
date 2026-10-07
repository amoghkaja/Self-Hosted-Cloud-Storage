import { type CleanupFile, type CleanupReport, formatBytes } from '@familycloud/shared';
import { Copy, HardDrive, History, Trash2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import { errorMessage, thumbUrl } from '../../api/client';
import { useCleanup, useDeleteAllVersions, usePurge, useTrashNodes } from '../../api/queries';
import { StorageSummary } from '../../app/StorageSummary';
import {
  Button,
  ConfirmDialog,
  EmptyState,
  IconButton,
  QueryState,
  Skeleton,
  Tabs,
  toast,
} from '../../components/ui';
import { usePageTitle } from '../../lib/usePageTitle';
import { FileIcon } from '../files/FileIcon';
import { VersionsDialog } from '../files/VersionsDialog';

const list = 'divide-y divide-border rounded-2xl border border-border bg-surface';

function FileRow({
  file,
  detail,
  children,
}: {
  file: CleanupFile;
  detail: string;
  children?: ReactNode;
}) {
  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <FileIcon
        node={file}
        thumbSrc={file.thumb === 'ready' ? thumbUrl(file.id, 256, file.updatedAt) : undefined}
      />
      <div className="min-w-0 flex-1">
        <Link
          to={`/files/${file.parentId}`}
          className="block truncate text-sm font-medium hover:underline"
        >
          {file.name}
        </Link>
        <p className="truncate text-xs text-muted">
          {file.folder ? `In ${file.folder}` : 'In My Files'} · {detail}
        </p>
      </div>
      {children}
    </li>
  );
}

/** Moves one file to the trash, which frees its space once the trash is emptied. */
function TrashButton({ file }: { file: CleanupFile }) {
  const trash = useTrashNodes();
  const busy = trash.isPending;
  return (
    <IconButton
      label={`Move ${file.name} to the trash`}
      icon={<Trash2 />}
      disabled={busy}
      onClick={async () => {
        const res = await trash.mutateAsync({ items: [file] });
        if (res.failed.length) toast.error(errorMessage(res.failed[0]!.error));
        else toast.success(`Moved “${file.name}” to the trash. Empty the trash to free the space.`);
      }}
    />
  );
}

function Largest({ files }: { files: CleanupFile[] }) {
  if (!files.length) {
    return <EmptyState icon={<HardDrive />} title="No files yet" description="Nothing to free." />;
  }
  return (
    <ul className={list} aria-label="Your biggest files">
      {files.map((f) => (
        <FileRow key={f.id} file={f} detail={formatBytes(f.size)}>
          <TrashButton file={f} />
        </FileRow>
      ))}
    </ul>
  );
}

function Duplicates({ groups }: { groups: CleanupReport['duplicates'] }) {
  if (!groups.length) {
    return (
      <EmptyState
        icon={<Copy />}
        title="No copies"
        description="Every file in your space is different. Nothing is stored twice."
      />
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        The same file in more than one place. Each copy counts toward your space: keep the one you
        want and move the others to the trash.
      </p>
      {groups.map((g) => (
        <section key={g.files[0]?.id} className="flex flex-col gap-2">
          <h2 className="text-sm font-medium">
            {g.count} copies of {g.files[0]?.name} ·{' '}
            <span className="text-muted">{formatBytes(g.size * (g.count - 1))} could be freed</span>
          </h2>
          <ul className={list}>
            {g.files.map((f) => (
              <FileRow key={f.id} file={f} detail={formatBytes(f.size)}>
                <TrashButton file={f} />
              </FileRow>
            ))}
          </ul>
          {g.count > g.files.length && (
            <p className="text-xs text-muted">
              And {g.count - g.files.length} more. Search for the name to find them.
            </p>
          )}
        </section>
      ))}
    </div>
  );
}

function Versions({ versions }: { versions: CleanupReport['versions'] }) {
  const removeAll = useDeleteAllVersions();
  const [confirm, setConfirm] = useState(false);
  const [open, setOpen] = useState<CleanupFile | null>(null);
  if (!versions.count) {
    return (
      <EmptyState
        icon={<History />}
        title="No older versions"
        description="When you save over a file, what it held is kept here for a while."
      />
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="flex-1 text-sm text-muted">
          {versions.count} older {versions.count === 1 ? 'version' : 'versions'} of files you saved
          over take {formatBytes(versions.bytes)}. They're deleted on their own after a while, and
          make way by themselves when your space runs out.
        </p>
        <Button variant="danger" icon={<Trash2 size={16} />} onClick={() => setConfirm(true)}>
          Delete all older versions
        </Button>
      </div>
      <ul className={list} aria-label="Files with older versions">
        {versions.files.map((v) => (
          <FileRow
            key={v.file.id}
            file={v.file}
            detail={`${v.count} older ${v.count === 1 ? 'version' : 'versions'} · ${formatBytes(v.bytes)}`}
          >
            <Button size="sm" icon={<History size={14} />} onClick={() => setOpen(v.file)}>
              Versions
            </Button>
          </FileRow>
        ))}
      </ul>
      {open && <VersionsDialog node={open} onClose={() => setOpen(null)} />}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        tone="danger"
        title="Delete all older versions?"
        description={`Every older version of your files goes for good, freeing ${formatBytes(versions.bytes)}. The files themselves stay as they are now.`}
        confirmLabel="Delete versions"
        onConfirm={async () => {
          try {
            const freed = await removeAll.mutateAsync();
            toast.success(`Freed ${formatBytes(freed.bytes)}`);
          } catch (err) {
            toast.error(errorMessage(err));
          }
        }}
      />
    </div>
  );
}

function TrashSummary({ trash }: { trash: CleanupReport['trash'] }) {
  const purge = usePurge();
  const [confirm, setConfirm] = useState(false);
  if (!trash.count) {
    return <EmptyState icon={<Trash2 />} title="Trash is empty" description="Nothing to free." />;
  }
  return (
    <div className="flex flex-col items-start gap-3">
      <p className="text-sm text-muted">
        {trash.count} {trash.count === 1 ? 'item' : 'items'} in the trash still{' '}
        {trash.count === 1 ? 'takes' : 'take'} {formatBytes(trash.bytes)} until{' '}
        {trash.count === 1 ? 'it’s' : 'they’re'} deleted for good.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="danger" icon={<Trash2 size={16} />} onClick={() => setConfirm(true)}>
          Empty trash
        </Button>
        <Button asChild>
          <Link to="/trash">Look through the trash</Link>
        </Button>
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        tone="danger"
        title="Empty the trash?"
        description={`This can't be undone. ${formatBytes(trash.bytes)} is freed immediately.`}
        confirmLabel="Delete forever"
        onConfirm={async () => {
          try {
            await purge.mutateAsync('all');
            toast.success(`Freed ${formatBytes(trash.bytes)}`);
          } catch (err) {
            toast.error(errorMessage(err));
          }
        }}
      />
    </div>
  );
}

/** What takes up your space, and what you could let go of. */
export function FreeUpSpacePage() {
  usePageTitle('Free up space');
  const report = useCleanup();
  const [tab, setTab] = useState('largest');
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5">
      <div className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold">Free up space</h1>
        <StorageSummary cleanupLink={false} />
      </div>
      <QueryState query={report} loading={<Skeleton className="h-64" />}>
        {(r) => (
          <Tabs
            label="Ways to free up space"
            value={tab}
            onValueChange={setTab}
            items={[
              { value: 'largest', label: 'Biggest', content: <Largest files={r.largest} /> },
              {
                value: 'copies',
                label: r.duplicates.length ? `Copies (${r.duplicates.length})` : 'Copies',
                content: <Duplicates groups={r.duplicates} />,
              },
              { value: 'versions', label: 'Versions', content: <Versions versions={r.versions} /> },
              { value: 'trash', label: 'Trash', content: <TrashSummary trash={r.trash} /> },
            ]}
          />
        )}
      </QueryState>
    </div>
  );
}
