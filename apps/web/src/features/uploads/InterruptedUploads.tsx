import { formatBytes } from '@familycloud/shared';
import { RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { PendingUpload } from '../../api/upload-manager';
import { uploadManager } from '../../app/providers';
import { Button, toast } from '../../components/ui';

/**
 * Uploads that were still running when the tab or app was closed. Browsers can't reopen a file
 * on their own, so we ask for the same files again; only the missing pieces are then sent.
 */
export function InterruptedUploads() {
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    void uploadManager.interrupted().then((list) => live && setPending(list));
    return () => {
      live = false;
    };
  }, []);

  if (pending.length === 0) return null;
  const names = pending.map((p) => p.name);
  const total = pending.reduce((s, p) => s + p.size, 0);

  const onPick = (files: File[]) => {
    const matched = uploadManager.resume(pending, files);
    const left = pending.filter(
      (p) =>
        !files.some(
          (f) => f.name === p.name && f.size === p.size && f.lastModified === p.lastModified,
        ),
    );
    setPending(left);
    if (matched) toast.success(`Continuing ${matched} ${matched === 1 ? 'upload' : 'uploads'}`);
    else toast.error('Those aren’t the same files. Pick the ones listed.');
  };

  return (
    <section
      aria-label="Unfinished uploads"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-warning-soft px-4 py-2 text-sm md:px-6"
    >
      <RotateCcw size={16} aria-hidden className="shrink-0 text-warning" />
      <span className="min-w-0 flex-1">
        {pending.length === 1 ? '1 upload' : `${pending.length} uploads`} didn’t finish (
        {names.slice(0, 2).join(', ')}
        {names.length > 2 ? ` and ${names.length - 2} more` : ''}, {formatBytes(total)}). Choose the
        same files to continue where they stopped.
      </span>
      <input
        ref={picker}
        type="file"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          onPick([...(e.target.files ?? [])]);
          e.target.value = '';
        }}
      />
      <Button size="sm" variant="primary" onClick={() => picker.current?.click()}>
        Choose files
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          uploadManager.discard(pending);
          setPending([]);
        }}
      >
        Discard
      </Button>
    </section>
  );
}
