import { formatBytes } from '@familycloud/shared';
import { ChevronLeft, ChevronRight, Download, File, X } from 'lucide-react';
import { Dialog as D } from 'radix-ui';
import { useEffect, useState } from 'react';
import { Button, EmptyState, Spinner, useReturnFocus } from '../../components/ui';
import { kindOf } from './FileIcon';

export interface PreviewItem {
  id: string;
  name: string;
  mimeType: string | null;
  size: number;
  type: 'file' | 'folder';
  thumb: 'none' | 'pending' | 'ready' | 'failed' | 'unsupported';
}

export interface PreviewSource {
  content: (id: string, inline: boolean) => string;
  thumb: (id: string, size: 256 | 1600) => string;
  canDownload: boolean;
}

const BROWSER_IMAGES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
]);
const TEXT_LIMIT = 256 * 1024;

function TextPreview({ url }: { url: string }) {
  const [state, setState] = useState<{ text: string; truncated: boolean } | 'error' | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    setState(null);
    fetch(url, {
      headers: { Range: `bytes=0-${TEXT_LIMIT - 1}` },
      signal: ctrl.signal,
      credentials: 'same-origin',
    })
      .then(async (r) => {
        if (!r.ok) throw new Error();
        const text = await r.text();
        const total = Number(r.headers.get('content-range')?.split('/')[1] ?? text.length);
        setState({ text, truncated: total > TEXT_LIMIT });
      })
      .catch((err: Error) => err.name !== 'AbortError' && setState('error'));
    return () => ctrl.abort();
  }, [url]);
  if (state === null) return <Spinner label="Loading text" className="text-white" />;
  if (state === 'error') return <p className="text-white/80">Could not load this file.</p>;
  return (
    <div className="h-full w-full max-w-4xl overflow-auto rounded-xl bg-surface p-4">
      <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-text">
        {state.text}
      </pre>
      {state.truncated && (
        <p className="mt-3 text-xs text-muted">
          Showing the first 256 KB. Download to see the rest.
        </p>
      )}
    </div>
  );
}

function Viewer({ item, source }: { item: PreviewItem; source: PreviewSource }) {
  const [loaded, setLoaded] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the spinner whenever the shown file changes
  useEffect(() => setLoaded(false), [item.id]);
  const kind = kindOf(item);
  const mime = (item.mimeType ?? '').toLowerCase();

  if (kind === 'image') {
    // Prefer the 1600px WebP: fast on phones and works for HEIC/TIFF that browsers can't show.
    const src =
      item.thumb === 'ready'
        ? source.thumb(item.id, 1600)
        : BROWSER_IMAGES.has(mime)
          ? source.content(item.id, true)
          : null;
    if (src) {
      return (
        <>
          {!loaded && <Spinner size={28} label="Loading image" className="absolute text-white" />}
          <img
            key={item.id}
            src={src}
            alt={item.name}
            onLoad={() => setLoaded(true)}
            className="max-h-full max-w-full object-contain"
          />
        </>
      );
    }
    if (item.thumb === 'pending')
      return <p className="text-white/80">Preview is still being prepared…</p>;
  }
  if (kind === 'video') {
    return (
      // biome-ignore lint/a11y/useMediaCaption: family videos have no caption tracks
      <video
        key={item.id}
        src={source.content(item.id, true)}
        poster={item.thumb === 'ready' ? source.thumb(item.id, 1600) : undefined}
        controls
        playsInline
        preload="metadata"
        className="max-h-full max-w-full rounded-lg"
      />
    );
  }
  if (kind === 'audio') {
    return (
      <div className="w-full max-w-md rounded-2xl bg-surface p-6 text-center">
        <p className="mb-4 truncate font-medium">{item.name}</p>
        {/* biome-ignore lint/a11y/useMediaCaption: user audio has no captions */}
        <audio key={item.id} src={source.content(item.id, true)} controls className="w-full" />
      </div>
    );
  }
  if (kind === 'pdf') {
    return (
      <iframe
        key={item.id}
        src={source.content(item.id, true)}
        title={item.name}
        className="h-full w-full max-w-5xl rounded-lg bg-white"
      />
    );
  }
  if (kind === 'text' || kind === 'code')
    return <TextPreview url={source.content(item.id, true)} />;

  return (
    <div className="rounded-2xl bg-surface">
      <EmptyState
        icon={<File />}
        title="No preview for this file type"
        description={`${item.name} · ${formatBytes(item.size)}`}
        action={
          source.canDownload && (
            <Button asChild variant="primary" icon={<Download size={16} />}>
              <a href={source.content(item.id, false)} download>
                Download
              </a>
            </Button>
          )
        }
      />
    </div>
  );
}

export default function PreviewModal({
  items,
  index,
  onIndexChange,
  onClose,
  source,
}: {
  items: PreviewItem[];
  index: number;
  onIndexChange: (i: number) => void;
  onClose: () => void;
  source: PreviewSource;
}) {
  const item = items[index];
  const onCloseAutoFocus = useReturnFocus(true);
  const hasPrev = index > 0;
  const hasNext = index < items.length - 1;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('video, audio, iframe')) return;
      if (e.key === 'ArrowLeft' && hasPrev) onIndexChange(index - 1);
      if (e.key === 'ArrowRight' && hasNext) onIndexChange(index + 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, hasPrev, hasNext, onIndexChange]);

  if (!item) return null;
  const navBtn =
    'absolute top-1/2 z-10 flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70 disabled:hidden';

  return (
    <D.Root open onOpenChange={(o) => !o && onClose()}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black/90 animate-fade-in" />
        <D.Content
          className="fixed inset-0 z-50 flex flex-col outline-none"
          onCloseAutoFocus={onCloseAutoFocus}
        >
          <header className="flex h-14 shrink-0 items-center gap-3 px-3 text-white">
            <div className="min-w-0 flex-1">
              <D.Title className="truncate text-sm font-medium">{item.name}</D.Title>
              <D.Description className="text-xs text-white/60">
                {items.length > 1 ? `${index + 1} of ${items.length} · ` : ''}
                {formatBytes(item.size)}
              </D.Description>
            </div>
            {source.canDownload && (
              <a
                href={source.content(item.id, false)}
                download
                aria-label={`Download ${item.name}`}
                className="flex size-10 items-center justify-center rounded-lg hover:bg-white/10"
              >
                <Download size={20} aria-hidden />
              </a>
            )}
            <D.Close
              aria-label="Close preview"
              className="flex size-10 items-center justify-center rounded-lg hover:bg-white/10"
            >
              <X size={22} aria-hidden />
            </D.Close>
          </header>
          <div className="relative flex min-h-0 flex-1 items-center justify-center px-2 pb-4 sm:px-16">
            <button
              type="button"
              aria-label="Previous file"
              disabled={!hasPrev}
              onClick={() => onIndexChange(index - 1)}
              className={`${navBtn} left-2`}
            >
              <ChevronLeft size={24} aria-hidden />
            </button>
            <Viewer item={item} source={source} />
            <button
              type="button"
              aria-label="Next file"
              disabled={!hasNext}
              onClick={() => onIndexChange(index + 1)}
              className={`${navBtn} right-2`}
            >
              <ChevronRight size={24} aria-hidden />
            </button>
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
