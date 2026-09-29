import { type FileNode, formatBytes } from '@familycloud/shared';
import { Download, History, RotateCcw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { errorMessage, versionUrl } from '../../api/client';
import { useVersionMutations, useVersions } from '../../api/queries';
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  IconButton,
  QueryState,
  Skeleton,
  toast,
} from '../../components/ui';
import { formatDateTime, formatRelative } from '../../lib/format';
import { triggerDownload } from './actions';

/**
 * A file's older versions, newest first: download one, bring it back (what's there now is kept
 * as a version too, so that's undoable), or, for the owner, delete them.
 */
export function VersionsDialog({ node, onClose }: { node: FileNode; onClose: () => void }) {
  const versions = useVersions(node.id);
  const m = useVersionMutations(node);
  const [confirm, setConfirm] = useState<{ id: string | 'all'; label: string } | null>(null);

  const restore = async (id: string, when: string) => {
    try {
      await m.restore.mutateAsync(id);
      toast.success(`Restored the version from ${when}`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Version history: “${node.name}”`}
      size="md"
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <QueryState query={versions} loading={<Skeleton className="h-40" />}>
        {(d) => (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted">
              {d.retentionDays > 0
                ? `When this file is saved over, what it held is kept for ${d.retentionDays} days. Older versions count toward the owner's storage.`
                : 'Your admin has turned versions off, so saving over a file replaces it for good.'}
            </p>
            <ul className="divide-y divide-border rounded-xl border border-border">
              <li className="flex items-center gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    {formatDateTime(d.current.modifiedAt)} <Badge tone="accent">Current</Badge>
                  </p>
                  <p className="text-xs text-muted">
                    {formatBytes(d.current.size)}
                    {d.current.modifiedBy ? ` · saved by ${d.current.modifiedBy.displayName}` : ''}
                  </p>
                </div>
              </li>
              {d.items.map((v) => {
                const when = formatDateTime(v.modifiedAt);
                return (
                  <li key={v.id} className="flex items-center gap-2 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{when}</p>
                      <p className="text-xs text-muted">
                        {formatBytes(v.size)}
                        {v.modifiedBy ? ` · saved by ${v.modifiedBy.displayName}` : ''} · replaced{' '}
                        {formatRelative(v.replacedAt)}
                      </p>
                    </div>
                    <IconButton
                      label={`Download the version from ${when}`}
                      icon={<Download />}
                      onClick={() => triggerDownload(versionUrl(node.id, v.id))}
                    />
                    <Button
                      size="sm"
                      icon={<RotateCcw size={14} />}
                      loading={m.restore.isPending && m.restore.variables === v.id}
                      onClick={() => void restore(v.id, when)}
                      aria-label={`Restore the version from ${when}`}
                    >
                      Restore
                    </Button>
                    {d.canDelete && (
                      <IconButton
                        label={`Delete the version from ${when}`}
                        icon={<Trash2 />}
                        onClick={() => setConfirm({ id: v.id, label: `the version from ${when}` })}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
            {d.items.length === 0 && (
              <EmptyState
                icon={<History />}
                title="No older versions"
                description="They appear here when the file is saved over."
                className="py-6"
              />
            )}
            {d.canDelete && d.items.length > 1 && (
              <Button
                variant="ghost"
                className="self-start"
                icon={<Trash2 size={16} />}
                onClick={() => setConfirm({ id: 'all', label: 'all older versions' })}
              >
                Delete all older versions
              </Button>
            )}
          </div>
        )}
      </QueryState>
      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        tone="danger"
        title={`Delete ${confirm?.label}?`}
        description="This can't be undone. The current file isn't affected."
        confirmLabel="Delete forever"
        onConfirm={async () => {
          try {
            if (confirm?.id === 'all') await m.removeAll.mutateAsync();
            else if (confirm) await m.remove.mutateAsync(confirm.id);
            toast.success('Deleted');
          } catch (err) {
            toast.error(errorMessage(err));
            throw err;
          }
        }}
      />
    </Dialog>
  );
}
