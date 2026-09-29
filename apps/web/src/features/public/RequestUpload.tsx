import type { PublicLinkInfo } from '@familycloud/shared';
import { CloudUpload } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { memoryPendingStore, requestTransport, UploadManager } from '../../api/upload-manager';
import {
  Button,
  collectDroppedFiles,
  DropZone,
  filesFromInput,
  type PickedFile,
  TextField,
  toast,
} from '../../components/ui';
import { formatDateTime } from '../../lib/format';
import { UploadRow } from '../uploads/UploadPanel';

const NAME_KEY = 'fc-sender-name';

/**
 * A file request, as the person asked to send files sees it: who's asking and for what, their
 * name (so the owner can tell who sent what), and an upload box. They never see the folder, and
 * only their own uploads in this browser are listed.
 */
export function RequestUpload({ token, info }: { token: string; info: PublicLinkInfo }) {
  const [from, setFrom] = useState(() => {
    try {
      return localStorage.getItem(NAME_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const fromRef = useRef(from);
  fromRef.current = from;
  const manager = useMemo(
    () =>
      new UploadManager(
        requestTransport(token, () => fromRef.current.trim()),
        // Nothing to resume across visits: the sender has no account to come back to.
        { pending: memoryPendingStore() },
      ),
    [token],
  );
  const items = useSyncExternalStore(manager.subscribe, manager.getSnapshot);
  const input = useRef<HTMLInputElement>(null);
  const sent = items.filter((i) => i.status === 'done').length;

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (manager.busy) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [manager]);

  const send = (picked: PickedFile[]) => {
    if (!picked.length) return;
    try {
      localStorage.setItem(NAME_KEY, from.trim());
    } catch {}
    // Folders are sent as their files: the request has one place to put things.
    manager.add(
      'request',
      picked.map((p) => ({ file: p.file, relativeDir: '' })),
    );
  };

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-5">
      <div>
        <h1 className="font-serif text-[28px] leading-tight">
          {info.title ?? `Send files to ${info.sharedBy}`}
        </h1>
        <p className="mt-2 text-sm text-muted">
          {info.sharedBy} asked you to send {info.title ? 'these' : 'some files'}. What you send
          goes straight to them. You won't see what anyone else sent, and it can't be changed once
          it's sent.
          {info.expiresAt && ` Open until ${formatDateTime(info.expiresAt)}.`}
        </p>
      </div>
      <TextField
        label="Your name"
        hint="So they know who sent what. Optional."
        autoComplete="name"
        maxLength={60}
        value={from}
        onChange={(e) => setFrom(e.target.value)}
      />
      <DropZone
        label="Drop to send"
        onDrop={(dt) =>
          collectDroppedFiles(dt).then(send, () => toast.error("Couldn't read the dropped files"))
        }
      >
        <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-border-strong bg-surface px-4 py-10 text-center">
          <CloudUpload size={32} className="text-accent" aria-hidden />
          <p className="text-sm text-muted">Drag photos or files here, or</p>
          <Button variant="primary" size="lg" onClick={() => input.current?.click()}>
            Choose files to send
          </Button>
        </div>
      </DropZone>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) send(filesFromInput(e.target.files));
          e.target.value = '';
        }}
      />
      {items.length > 0 && (
        <section aria-label="Your files" className="rounded-2xl border border-border bg-surface">
          {sent > 0 && (
            <p role="status" className="border-b border-border px-4 py-2.5 text-sm font-medium">
              {sent === 1 ? '1 file sent' : `${sent} files sent`}
              {sent === items.length ? '. Thank you!' : ''}
            </p>
          )}
          <ul className="divide-y divide-border">
            {items.map((item) => (
              <UploadRow key={item.id} item={item} manager={manager} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
