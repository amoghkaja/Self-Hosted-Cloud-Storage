import type { RewindPreview, RewindResult } from '@familycloud/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api, errorMessage } from '../../api/client';
import { useSetupStatus } from '../../api/queries';
import { Button, Dialog, SelectField, Skeleton, TextField, toast } from '../../components/ui';

const HOUR = 3600_000;
const PRESETS: { value: string; label: string; ms: number }[] = [
  { value: '1h', label: 'An hour ago', ms: HOUR },
  { value: '1d', label: 'This time yesterday', ms: 24 * HOUR },
  { value: '1w', label: 'A week ago', ms: 7 * 24 * HOUR },
];

/** "2026-10-05T14:30" in local time, as a datetime-local input wants it. */
function localInput(d: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function names(list: string[], count: number) {
  const shown = list.map((n) => `“${n}”`).join(', ');
  return count > list.length ? `${shown} and ${count - list.length} more` : shown;
}

/**
 * Puts a folder back as it was at an earlier moment: deleted things come out of the trash, and
 * files saved over get back what they held. Shows what it will do before doing it.
 */
export function RewindDialog({
  folder,
  onClose,
}: {
  folder: { id: string; name: string };
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const retention = useSetupStatus().data?.trashRetentionDays ?? 30;
  const [choice, setChoice] = useState('1h');
  const [custom, setCustom] = useState(() => localInput(new Date(Date.now() - 24 * HOUR)));
  // Fixed when picked, so the preview doesn't refetch as the clock moves.
  const at = useMemo(() => {
    const preset = PRESETS.find((p) => p.value === choice);
    const d = preset ? new Date(Date.now() - preset.ms) : new Date(custom);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }, [choice, custom]);

  const preview = useQuery({
    queryKey: ['rewind', folder.id, at],
    queryFn: () => api<RewindPreview>(`/nodes/${folder.id}/rewind`, { query: { at: at! } }),
    enabled: !!at,
    retry: false,
  });
  const rewind = useMutation({
    mutationFn: () => api<RewindResult>(`/nodes/${folder.id}/rewind`, { json: { at } }),
    onSettled: () => {
      for (const key of [['children'], ['node'], ['trash'], ['me'], ['versions'], ['search']]) {
        void qc.invalidateQueries({ queryKey: key });
      }
    },
  });

  const p = preview.data;
  const nothing = p && p.restore.count === 0 && p.revert.count === 0;
  const run = async () => {
    try {
      const r = await rewind.mutateAsync();
      const parts = [
        r.restored ? `put back ${r.restored} deleted ${r.restored === 1 ? 'item' : 'items'}` : '',
        r.reverted ? `${r.reverted} ${r.reverted === 1 ? 'file' : 'files'} as they were` : '',
      ].filter(Boolean);
      toast.success(
        parts.length ? `Rewound “${folder.name}”: ${parts.join(', ')}` : 'Nothing to change',
      );
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Rewind “${folder.name}”`}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={rewind.isPending}
            disabled={!p || nothing}
            onClick={run}
          >
            Rewind
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 text-sm">
        <p>
          Put this folder back as it was: deleted files come back out of the trash, and files that
          were saved over get back what they held. Nothing is lost: what files hold now is kept as
          an older version.
        </p>
        <SelectField label="Go back to" value={choice} onChange={(e) => setChoice(e.target.value)}>
          {PRESETS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
          <option value="custom">A date and time…</option>
        </SelectField>
        {choice === 'custom' && (
          <TextField
            label="Date and time"
            type="datetime-local"
            value={custom}
            min={localInput(new Date(Date.now() - retention * 24 * HOUR))}
            max={localInput(new Date())}
            onChange={(e) => setCustom(e.target.value)}
            hint={`Up to ${retention} days back, as long as the trash keeps things.`}
          />
        )}
        <div aria-live="polite" className="rounded-xl bg-surface-2 p-3">
          {preview.isError ? (
            <p className="text-danger">{errorMessage(preview.error)}</p>
          ) : !p ? (
            <Skeleton className="h-10" />
          ) : nothing ? (
            <p>Nothing was deleted or saved over in this folder since then.</p>
          ) : (
            <ul className="flex list-disc flex-col gap-1 pl-5">
              {p.restore.count > 0 && (
                <li>
                  Puts back {p.restore.count} deleted {p.restore.count === 1 ? 'item' : 'items'}:{' '}
                  {names(p.restore.names, p.restore.count)}.
                </li>
              )}
              {p.revert.count > 0 && (
                <li>
                  Gives {p.revert.count} {p.revert.count === 1 ? 'file' : 'files'} back what{' '}
                  {p.revert.count === 1 ? 'it' : 'they'} held then:{' '}
                  {names(p.revert.names, p.revert.count)}.
                </li>
              )}
              {p.added > 0 && (
                <li className="text-muted">
                  {p.added} {p.added === 1 ? 'file' : 'files'} added since then{' '}
                  {p.added === 1 ? 'stays' : 'stay'}.
                </li>
              )}
            </ul>
          )}
        </div>
      </div>
    </Dialog>
  );
}
