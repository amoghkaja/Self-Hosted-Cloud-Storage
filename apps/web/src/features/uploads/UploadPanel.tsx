import { formatBytes } from '@familycloud/shared';
import { ChevronDown, CircleAlert, CircleCheck, RotateCcw, X } from 'lucide-react';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { UploadItem, UploadManager } from '../../api/upload-manager';
import { uploadManager, useUploads } from '../../app/providers';
import { announce, FileName, IconButton, Progress } from '../../components/ui';
import { cn } from '../../lib/cn';

// Memoized: the manager keeps an unchanged item's snapshot object, so a progress tick only
// re-renders the row that moved.
export const UploadRow = memo(function UploadRow({
  item,
  manager = uploadManager,
}: {
  item: UploadItem;
  manager?: UploadManager;
}) {
  const pct = item.size
    ? Math.round((item.loaded / item.size) * 100)
    : item.status === 'done'
      ? 100
      : 0;
  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="flex text-sm font-medium" title={item.name}>
          <FileName name={item.name} />
        </p>
        {item.status === 'error' ? (
          <p className="truncate text-xs text-danger">{item.error}</p>
        ) : item.status === 'done' ? (
          <p className="text-xs text-muted">
            {formatBytes(item.size)}
            {item.instant && ' · already stored, added instantly'}
          </p>
        ) : item.checking ? (
          <p className="text-xs text-muted">Checking whether it's already stored…</p>
        ) : item.status === 'canceled' ? (
          <p className="text-xs text-muted">Cancelled</p>
        ) : (
          <div className="mt-1.5 flex items-center gap-2">
            <Progress value={pct} label={`Uploading ${item.name}`} className="flex-1" />
            <span className="w-10 text-right text-xs text-muted tabular-nums">
              {item.status === 'queued'
                ? 'Waiting'
                : item.status === 'finalizing'
                  ? '…'
                  : `${pct}%`}
            </span>
          </div>
        )}
      </div>
      {item.status === 'done' && (
        <CircleCheck size={18} className="shrink-0 text-success" aria-label="Uploaded" />
      )}
      {item.status === 'error' && (
        <CircleAlert size={18} className="shrink-0 text-danger" aria-hidden />
      )}
      {(item.status === 'error' || item.status === 'canceled') && (
        <IconButton
          size="sm"
          label={`Retry ${item.name}`}
          icon={<RotateCcw />}
          onClick={() => manager.retry(item.id)}
        />
      )}
      {(item.status === 'queued' || item.status === 'uploading') && (
        <IconButton
          size="sm"
          label={`Cancel ${item.name}`}
          icon={<X />}
          onClick={() => manager.cancel(item.id)}
        />
      )}
    </li>
  );
});

/** Docked upload progress. Collapsible; warns before leaving the page while uploads run. */
export function UploadPanel() {
  const items = useUploads();
  const [collapsed, setCollapsed] = useState(false);
  const stats = useMemo(() => {
    let done = 0;
    let failed = 0;
    let active = 0;
    let loaded = 0;
    let total = 0;
    for (const i of items) {
      if (i.status === 'done') done++;
      else if (i.status === 'error') failed++;
      else if (i.status !== 'canceled') active++;
      if (i.status !== 'canceled') {
        loaded += i.loaded;
        total += i.size;
      }
    }
    return { done, failed, active, loaded, total };
  }, [items]);

  const wasActive = useRef(false);
  useEffect(() => {
    if (wasActive.current && stats.active === 0 && stats.done + stats.failed > 0) {
      announce(
        stats.failed
          ? `Uploads finished, ${stats.failed} failed`
          : `${stats.done} uploads complete`,
      );
    }
    wasActive.current = stats.active > 0;
  }, [stats.active, stats.done, stats.failed]);

  useEffect(() => {
    if (stats.active === 0) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Older browsers only show the prompt when returnValue is set.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [stats.active]);

  // The panel floats over the bottom of the page; publish its height so the page can pad its
  // end and the last files stay reachable instead of hiding underneath it.
  const panel = useRef<HTMLElement>(null);
  const visible = items.length > 0;
  useLayoutEffect(() => {
    const el = panel.current;
    if (!visible || !el) return;
    const root = document.documentElement;
    const ro = new ResizeObserver(() =>
      root.style.setProperty('--upload-panel-h', `${el.offsetHeight + 8}px`),
    );
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty('--upload-panel-h');
    };
  }, [visible]);

  if (items.length === 0) return null;
  const title =
    stats.active > 0
      ? `Uploading ${stats.active} item${stats.active === 1 ? '' : 's'}`
      : stats.failed
        ? `${stats.failed} upload${stats.failed === 1 ? '' : 's'} failed`
        : `${stats.done} upload${stats.done === 1 ? '' : 's'} complete`;

  return (
    <section
      ref={panel}
      aria-label="Uploads"
      className="glass-thick fixed right-2 bottom-[max(0.5rem,env(safe-area-inset-bottom),calc(var(--tabbar-h,0px)+0.5rem))] left-2 z-40 overflow-hidden rounded-2xl border border-(--glass-edge) shadow-(--glass-shadow) sm:left-auto sm:w-[380px] animate-pop-in"
    >
      <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">{title}</h2>
          {stats.active > 0 && (
            <p className="text-xs text-muted tabular-nums">
              {formatBytes(stats.loaded)} of {formatBytes(stats.total)}
            </p>
          )}
        </div>
        <IconButton
          size="sm"
          label={collapsed ? 'Expand uploads' : 'Collapse uploads'}
          icon={<ChevronDown className={cn('transition-transform', collapsed && 'rotate-180')} />}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((c) => !c)}
        />
        {stats.active === 0 && (
          <IconButton
            size="sm"
            label="Close uploads"
            icon={<X />}
            onClick={() => uploadManager.clearFinished()}
          />
        )}
      </header>
      {!collapsed && (
        <ul className="max-h-72 divide-y divide-border overflow-y-auto">
          {items.map((i) => (
            <UploadRow key={i.id} item={i} />
          ))}
        </ul>
      )}
    </section>
  );
}
