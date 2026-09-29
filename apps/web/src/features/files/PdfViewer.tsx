import type { PDFDocumentProxy } from 'pdfjs-dist';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Spinner } from '../../components/ui';

/**
 * Touch screens: phone browsers show a PDF in an iframe as one zoomed-in first page (iOS) or not
 * at all (Android). Render the pages ourselves instead, fitted to the width and scrolled like a
 * document. Pages are drawn as they come into view, so long files open quickly.
 */
export function PdfViewer({
  url,
  title,
  fallback,
}: {
  url: string;
  title: string;
  fallback: ReactNode;
}) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [failed, setFailed] = useState(false);
  const [width, setWidth] = useState(0);
  const [current, setCurrent] = useState(1);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let task: { destroy: () => Promise<void> } | null = null;
    (async () => {
      const [pdfjs, { default: workerUrl }] = await Promise.all([
        import('pdfjs-dist'),
        import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
      ]);
      if (cancelled) return;
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      const loading = pdfjs.getDocument({ url });
      task = loading;
      const loaded = await loading.promise;
      if (!cancelled) setDoc(loaded);
    })().catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [url]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (failed) return fallback;
  return (
    <div className="relative flex h-full w-full max-w-3xl flex-col">
      <div
        ref={scroller}
        role="document"
        aria-label={title}
        // Arrow keys scroll the document here instead of switching files.
        data-own-keys=""
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        {!doc || !width ? (
          <div className="flex h-full items-center justify-center">
            <Spinner size={28} label="Loading PDF" className="text-white" />
          </div>
        ) : (
          <ol className="flex flex-col gap-3 pb-12">
            {Array.from({ length: doc.numPages }, (_, i) => (
              <PdfPage
                // biome-ignore lint/suspicious/noArrayIndexKey: pages are fixed for a document
                key={i}
                doc={doc}
                number={i + 1}
                width={width}
                root={scroller.current}
                onVisible={setCurrent}
              />
            ))}
          </ol>
        )}
      </div>
      {doc && doc.numPages > 1 && (
        <p
          aria-live="polite"
          className="glass-clear pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-white/20 px-3 py-1 text-xs text-white tabular-nums"
        >
          {current} of {doc.numPages}
        </p>
      )}
    </div>
  );
}

function PdfPage({
  doc,
  number,
  width,
  root,
  onVisible,
}: {
  doc: PDFDocumentProxy;
  number: number;
  width: number;
  root: HTMLElement | null;
  onVisible: (n: number) => void;
}) {
  const item = useRef<HTMLLIElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(number <= 2);
  // A4 portrait (1:√2) until the page itself says otherwise.
  const [ratio, setRatio] = useState(Math.SQRT2);

  useEffect(() => {
    const el = item.current;
    if (!el) return;
    // Drawn within a screen of the viewport; released beyond it (a page at 3x is ~8 MB).
    const io = new IntersectionObserver(
      (entries) => setNear(entries.some((e) => e.isIntersecting)),
      {
        root,
        rootMargin: '100% 0px',
      },
    );
    const seen = new IntersectionObserver(
      (entries) => entries.some((e) => e.isIntersecting) && onVisible(number),
      {
        root,
        threshold: 0.5,
      },
    );
    io.observe(el);
    seen.observe(el);
    return () => {
      io.disconnect();
      seen.disconnect();
    };
  }, [root, number, onVisible]);

  useEffect(() => {
    if (!near) return;
    let task: { cancel: () => void } | null = null;
    let cancelled = false;
    doc.getPage(number).then((page) => {
      const c = canvas.current;
      if (cancelled || !c) return;
      const base = page.getViewport({ scale: 1 });
      setRatio(base.height / base.width);
      // Sharp on high-density screens, capped so a long file doesn't exhaust a phone's memory.
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const viewport = page.getViewport({ scale: (width / base.width) * dpr });
      c.width = Math.floor(viewport.width);
      c.height = Math.floor(viewport.height);
      const render = page.render({ canvas: c, viewport });
      task = render;
      render.promise.catch(() => {});
    });
    return () => {
      cancelled = true;
      task?.cancel();
      const c = canvas.current;
      if (c) {
        c.width = 0;
        c.height = 0;
      }
    };
  }, [doc, number, width, near]);

  return (
    <li ref={item} className="bg-white" style={{ width, height: width * ratio }}>
      <canvas
        ref={canvas}
        aria-label={`Page ${number}`}
        role="img"
        className="block h-full w-full"
      />
    </li>
  );
}
