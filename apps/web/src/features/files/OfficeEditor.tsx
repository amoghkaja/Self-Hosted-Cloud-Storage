import type { EditSession } from '@familycloud/shared';
import { useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { invalidateEdited } from '../../api/queries';
import { Button, Spinner } from '../../components/ui';

/** Long enough for a big spreadsheet on a Raspberry Pi; after that, offer a way out. */
const SLOW_MS = 45_000;

type Message = { MessageId?: string; Values?: { Status?: string } };

/**
 * A file open in the document editor (Collabora Online), over the whole window. The editor runs
 * at its own address: the token goes to it in a form posted into the frame (never in a URL), and
 * only messages from that address and this frame are listened to. It saves by itself as you go
 * and when closed, through the server, which keeps the file as it was before as a version.
 */
export function OfficeEditor({
  nodeId,
  name,
  session,
  onClose: close,
}: {
  nodeId: string;
  name: string;
  session: EditSession;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  // Closing shows what was saved: the new size and date, preview and versions.
  const onClose = () => {
    invalidateEdited(qc, nodeId);
    close();
  };
  const frameName = `office-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const formRef = useRef<HTMLFormElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  // Opening: nothing from the editor yet. Ready: it shows its own progress (or what went wrong).
  const [state, setState] = useState<'opening' | 'ready' | 'loaded'>('opening');
  const [slow, setSlow] = useState(false);
  const latestClose = useRef(onClose);
  latestClose.current = onClose;

  useEffect(() => {
    formRef.current?.submit();
    const timer = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== session.origin || e.source !== frameRef.current?.contentWindow) return;
      let msg: Message;
      try {
        msg = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
      } catch {
        return;
      }
      if (msg?.MessageId === 'App_LoadingStatus') {
        if (msg.Values?.Status === 'Frame_Ready') {
          setState((s) => (s === 'opening' ? 'ready' : s));
          frameRef.current?.contentWindow?.postMessage(
            JSON.stringify({
              MessageId: 'Host_PostmessageReady',
              SendTime: Date.now(),
              Values: {},
            }),
            session.origin,
          );
        }
        if (msg.Values?.Status === 'Document_Loaded') setState('loaded');
      }
      if (msg?.MessageId === 'UI_Close') latestClose.current();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [session.origin]);

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-white pt-[env(safe-area-inset-top)]">
      {/* The editor has its own close button once the document is open. */}
      {state !== 'loaded' && (
        <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-black/10 px-3 text-neutral-800">
          <p className="min-w-0 flex-1 truncate text-sm font-medium">{name}</p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close the editor"
            className="flex size-11 items-center justify-center rounded-lg hover:bg-black/5"
          >
            <X size={22} aria-hidden />
          </button>
        </header>
      )}
      <form ref={formRef} action={session.url} method="post" target={frameName} className="hidden">
        <input type="hidden" name="access_token" value={session.accessToken} />
        <input type="hidden" name="access_token_ttl" value={String(session.accessTokenTtl)} />
      </form>
      <div className="relative min-h-0 flex-1">
        <iframe
          ref={frameRef}
          name={frameName}
          title={`Editing ${name}`}
          className="absolute inset-0 size-full border-0"
          allow="clipboard-read; clipboard-write; fullscreen"
        />
        {state === 'opening' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-white p-6 text-center text-neutral-700">
            <Spinner size={28} label="Opening the editor" />
            <p>Opening {name}…</p>
            {slow && (
              <div className="flex max-w-sm flex-col items-center gap-3 text-sm">
                <p>
                  The editor is taking a long time. If it was just turned on, it may still be
                  starting.
                </p>
                <Button onClick={onClose}>Back to the preview</Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
