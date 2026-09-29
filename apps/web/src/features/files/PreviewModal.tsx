import { formatBytes, isOfficeDocument } from '@familycloud/shared';
import { ChevronLeft, ChevronRight, Download, File, X } from 'lucide-react';
import { Dialog as D } from 'radix-ui';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Button, EmptyState, Spinner, useReturnFocus } from '../../components/ui';
import { type Gestures, useImageGestures } from '../../lib/useImageGestures';
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
  /** Videos: a streaming version sized for phones and slow links (falls back to `content`). */
  stream?: (id: string) => string;
  /** Word, Excel and PowerPoint files: a PDF rendering made by the server. */
  preview?: (id: string) => string;
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

/** A photo you can pinch, pan, double-tap and swipe (see useImageGestures). */
function ZoomableImage({
  item,
  src,
  gestures,
  onLoad,
  onError,
}: {
  item: PreviewItem;
  src: string;
  gestures: Gestures;
  onLoad: () => void;
  onError: () => void;
}) {
  const { state, zoomed, handlers } = useImageGestures(item.id, gestures);
  const dim = state.dragY > 0 ? Math.max(0.35, 1 - state.dragY / 400) : 1;
  return (
    <div
      {...handlers}
      // The browser must not pinch-zoom or scroll the page here: these gestures are the photo's.
      className="absolute inset-0 flex touch-none items-center justify-center overflow-hidden select-none [-webkit-touch-callout:none]"
      style={{ opacity: dim }}
    >
      <img
        key={item.id}
        src={src}
        alt={item.name}
        draggable={false}
        onLoad={onLoad}
        onError={onError}
        className="max-h-full max-w-full object-contain will-change-transform"
        style={{
          transform: `translate3d(${state.x + state.dragX}px, ${state.y + state.dragY}px, 0) scale(${state.scale})`,
          transition: state.active ? 'none' : 'transform 220ms cubic-bezier(.22,1,.36,1)',
          cursor: zoomed ? 'grab' : undefined,
        }}
      />
    </div>
  );
}

/**
 * Plays the streaming version (720p, starts fast abroad and plays everywhere) with a switch to
 * the original quality. The position carries over when switching.
 */
function VideoPlayer({ item, source }: { item: PreviewItem; source: PreviewSource }) {
  const [original, setOriginal] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const resumeAt = useRef(0);
  const src = original || !source.stream ? source.content(item.id, true) : source.stream(item.id);
  const toggle = () => {
    resumeAt.current = video.current?.currentTime ?? 0;
    setOriginal((o) => !o);
  };
  return (
    <div className="flex max-h-full max-w-full flex-col items-center gap-2">
      {/* biome-ignore lint/a11y/useMediaCaption: family videos have no caption tracks */}
      <video
        ref={video}
        key={`${item.id}-${original}`}
        src={src}
        poster={item.thumb === 'ready' ? source.thumb(item.id, 1600) : undefined}
        controls
        playsInline
        preload="metadata"
        onLoadedMetadata={(e) => {
          if (resumeAt.current) {
            e.currentTarget.currentTime = resumeAt.current;
            resumeAt.current = 0;
            void e.currentTarget.play().catch(() => {});
          }
        }}
        className="max-h-[calc(100dvh-10rem)] max-w-full rounded-lg"
      />
      {source.stream && (
        <button
          type="button"
          onClick={toggle}
          className="min-h-11 rounded-full px-3 text-xs text-white/70 hover:text-white"
        >
          {original ? 'Play the faster version' : 'Play in original quality'}
        </button>
      )}
    </div>
  );
}

type OfficeState = 'loading' | 'ready' | 'pending' | 'unavailable';
const OFFICE_POLL_MS = 4000;

/**
 * Shows the server's PDF rendering of an Office document. A new upload can take a moment to
 * convert, so this keeps checking until it's ready.
 */
function OfficeViewer({
  item,
  url,
  fallback,
}: {
  item: PreviewItem;
  url: string;
  fallback: ReactNode;
}) {
  const [state, setState] = useState<OfficeState>('loading');
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState('loading');
    const check = async () => {
      try {
        const res = await fetch(url, { method: 'HEAD', signal: abort.signal });
        if (res.ok) return setState('ready');
        const status = res.headers.get('X-Preview-Status');
        if (res.status === 404 && status === 'pending') {
          setState('pending');
          timer = setTimeout(check, OFFICE_POLL_MS);
        } else {
          setState('unavailable');
        }
      } catch {
        if (!abort.signal.aborted) setState('unavailable');
      }
    };
    void check();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [url]);

  if (state === 'ready') {
    return (
      <iframe
        key={item.id}
        src={url}
        title={item.name}
        className="h-full w-full max-w-5xl rounded-lg bg-white"
      />
    );
  }
  if (state === 'unavailable') return fallback;
  return (
    <div className="flex flex-col items-center gap-3 text-white/80">
      <Spinner size={28} label="Loading preview" />
      {state === 'pending' && <p>Preparing a preview of {item.name}…</p>}
    </div>
  );
}

function Viewer({
  item,
  source,
  gestures,
}: {
  item: PreviewItem;
  source: PreviewSource;
  gestures: Gestures;
}) {
  // Keyed by file rather than reset in an effect: a cached image can finish loading before an
  // effect runs, which left the spinner stuck on top of it.
  const [image, setImage] = useState<{ id: string; state: 'loaded' | 'error' } | null>(null);
  const imageState = image?.id === item.id ? image.state : 'loading';
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
    if (src && imageState === 'error') {
      return <p className="text-white/80">Could not load this image.</p>;
    }
    if (src) {
      return (
        <>
          {imageState === 'loading' && (
            <Spinner size={28} label="Loading image" className="absolute text-white" />
          )}
          <ZoomableImage
            item={item}
            src={src}
            gestures={gestures}
            onLoad={() => setImage({ id: item.id, state: 'loaded' })}
            onError={() => setImage({ id: item.id, state: 'error' })}
          />
        </>
      );
    }
    if (item.thumb === 'pending')
      return <p className="text-white/80">Preview is still being prepared…</p>;
  }
  if (kind === 'video') return <VideoPlayer item={item} source={source} />;
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

  const noPreview = (
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
  if (source.preview && isOfficeDocument(item.mimeType, item.name)) {
    return <OfficeViewer item={item} url={source.preview(item.id)} fallback={noPreview} />;
  }
  return noPreview;
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
  // On touch screens you swipe instead, so the arrows don't cover the photo.
  const navBtn =
    'absolute top-1/2 z-10 flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70 disabled:hidden pointer-coarse:hidden';
  const gestures: Gestures = {
    canPrev: hasPrev,
    canNext: hasNext,
    onSwipe: (dir) => onIndexChange(index + dir),
    onDismiss: onClose,
  };

  return (
    <D.Root open onOpenChange={(o) => !o && onClose()}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black animate-fade-in sm:bg-black/90" />
        <D.Content
          className="fixed inset-0 z-50 flex flex-col pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] outline-none"
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
                className="flex size-11 items-center justify-center rounded-lg hover:bg-white/10"
              >
                <Download size={20} aria-hidden />
              </a>
            )}
            <D.Close
              aria-label="Close preview"
              className="flex size-11 items-center justify-center rounded-lg hover:bg-white/10"
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
            <Viewer item={item} source={source} gestures={gestures} />
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
