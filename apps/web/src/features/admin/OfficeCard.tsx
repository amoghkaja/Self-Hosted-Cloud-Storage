import { formatBytes, GiB, type OfficeStatus } from '@familycloud/shared';
import { CheckCircle2, LoaderCircle, TriangleAlert } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { errorMessage } from '../../api/client';
import { useOfficeStatus, useSetOffice } from '../../api/queries';
import { ConfirmDialog, QueryState, Skeleton, SwitchField, toast } from '../../components/ui';

/** Below this, the editor is likely to leave too little memory for everything else. */
const LOW_MEMORY = 4 * GiB;

function Line({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <p role="status" className="flex gap-2 text-sm">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span className="min-w-0">{children}</span>
    </p>
  );
}

function Warning({ children }: { children: ReactNode }) {
  return (
    <p
      role="status"
      className="flex gap-2 rounded-xl border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning"
    >
      <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

const Command = ({ children }: { children: string }) => (
  <code className="font-mono text-[13px] break-all">{children}</code>
);

/** What the editor is doing now, in words. */
function State({ s }: { s: OfficeStatus }) {
  const helperGone =
    s.helper === 'missing'
      ? "The update helper, which does this from here, isn't set up on the server"
      : "The update helper, which does this from here, isn't answering";
  if (s.pending === 'on') {
    return (
      <Line icon={<LoaderCircle size={16} className="animate-spin" aria-hidden />}>
        Starting the editor. This takes about a minute (a few more the first time, while it
        downloads).
      </Line>
    );
  }
  if (s.pending === 'off') {
    return (
      <Line icon={<LoaderCircle size={16} className="animate-spin" aria-hidden />}>
        Removing the editor. Documents still open are saved first.
      </Line>
    );
  }
  if (s.enabled && s.running) {
    return (
      <Line icon={<CheckCircle2 size={16} className="text-success" aria-hidden />}>
        On, at {s.publicUrl}.{' '}
        {s.openDocuments > 0 &&
          `${s.openDocuments} ${s.openDocuments === 1 ? 'file was' : 'files were'} opened or saved in the last 10 minutes.`}
      </Line>
    );
  }
  if (s.enabled) {
    return (
      <Warning>
        On, but the editor isn't answering, so files can't be opened in it.{' '}
        {s.helper === 'ok' ? (
          <>
            If it was just turned on, it may still be starting. If this stays, run{' '}
            <Command>./scripts/office.sh status</Command> on the server.
          </>
        ) : (
          <>
            {helperGone}: run <Command>./scripts/office.sh on</Command> there to start it.
          </>
        )}
      </Warning>
    );
  }
  if (s.running) {
    return (
      <Warning>
        Off for everyone, but the editor is still running and using memory. {helperGone}: run{' '}
        <Command>./scripts/office.sh off</Command> there to remove it.
      </Warning>
    );
  }
  return (
    <Line icon={<CheckCircle2 size={16} className="text-muted" aria-hidden />}>
      Off and removed: it uses no memory. Office files open as PDFs.
    </Line>
  );
}

function OfficeSettings({ s }: { s: OfficeStatus }) {
  const set = useSetOffice();
  const [asking, setAsking] = useState<'on' | 'off' | null>(null);
  const memory = s.memory;
  const low = memory.totalBytes > 0 && memory.totalBytes < LOW_MEMORY;
  const change = (enabled: boolean) =>
    set.mutateAsync(enabled).then(
      () => toast.success(enabled ? 'Turning on the editor' : 'Turning off the editor'),
      (err) => {
        toast.error(errorMessage(err));
        throw err;
      },
    );

  if (!s.configured) {
    return (
      <div className="flex flex-col gap-2 text-sm">
        <p className="font-medium">Off (not installed)</p>
        <p className="text-muted">
          Opens Word, Excel and PowerPoint files in a full editor in the browser, and saves them
          back. It runs in a container of its own that needs about 1–2 GB of memory, so it isn't
          installed unless you add it. To add it, run <Command>./scripts/office.sh on</Command> on
          the server. After that, this switch turns it off and on: off removes it completely and
          gives the memory back.
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <SwitchField
        label="Edit documents in the browser"
        description="Word, Excel and PowerPoint files open in an editor for anyone who can change them. Each editing session keeps the file as it was before in Version history."
        checked={s.enabled}
        disabled={set.isPending}
        onCheckedChange={(on) => setAsking(on ? 'on' : 'off')}
      />
      <p className="text-xs text-muted">
        The editor uses about 1–2 GB of memory. If your server doesn't have that to spare, turn this
        off: it removes the editor completely, gives the memory back, and files open as PDFs as
        before. You can turn it on again here at any time. This server has{' '}
        {formatBytes(memory.totalBytes)} of memory ({formatBytes(memory.availableBytes)} free).
      </p>
      <State s={s} />
      <ConfirmDialog
        open={asking === 'on'}
        onOpenChange={(o) => !o && setAsking(null)}
        title="Turn on editing in the browser?"
        description={`The editor needs about 1–2 GB of memory. This server has ${formatBytes(memory.totalBytes)}, ${formatBytes(memory.availableBytes)} free.${low ? ' With under 4 GB, we recommend leaving it off: the rest of Family Cloud may slow down.' : ''} You can turn it off again here at any time, which removes it completely.`}
        confirmLabel="Turn on"
        onConfirm={() => change(true)}
      />
      <ConfirmDialog
        open={asking === 'off'}
        onOpenChange={(o) => !o && setAsking(null)}
        title="Turn off editing in the browser?"
        description={`${s.openDocuments > 0 ? 'Documents still open in the editor are saved first, then closed. ' : ''}The editor is removed and its memory given back; files open as PDFs again. You can turn it on again here at any time.`}
        confirmLabel="Turn off"
        onConfirm={() => change(false)}
      />
    </div>
  );
}

export function OfficeCard() {
  const q = useOfficeStatus();
  return (
    <section className="rounded-2xl border border-border bg-surface p-5">
      <h2 className="mb-4 text-base font-semibold">Document editor</h2>
      <QueryState query={q} loading={<Skeleton className="h-24" />}>
        {(s) => <OfficeSettings s={s} />}
      </QueryState>
    </section>
  );
}
