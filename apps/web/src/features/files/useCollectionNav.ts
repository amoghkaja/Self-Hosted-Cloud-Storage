import {
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { announce } from '../../components/ui';

export interface CollectionNavOptions {
  ids: string[];
  /** 1 for list view; tiles per row for grid view (enables left/right movement). */
  columns: number;
  onOpen: (index: number) => void;
  onDelete?: (ids: string[]) => void;
  onRename?: (index: number) => void;
  onMenu?: (index: number) => void;
  /** Scroll the virtualized list so the index is rendered before focusing it. */
  scrollToIndex: (index: number) => void;
  containerRef: React.RefObject<HTMLElement | null>;
}

const isTouch = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;

/**
 * Selection + roving focus for the file list/grid (WAI-ARIA grid pattern).
 * Selection is keyed by id so it survives re-sorting and background refreshes.
 */
export function useCollectionNav(o: CollectionNavOptions) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [focus, setFocus] = useState(0);
  const anchor = useRef<number | null>(null);
  const pendingFocus = useRef(false);
  const count = o.ids.length;

  // Drop selections for items that disappeared (deleted/moved elsewhere).
  useEffect(() => {
    setSelected((prev) => {
      const live = new Set(o.ids);
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
    setFocus((f) => Math.min(f, Math.max(0, count - 1)));
  }, [o.ids, count]);

  // After keyboard movement, bring the item into view and move DOM focus to it.
  useEffect(() => {
    if (!pendingFocus.current) return;
    pendingFocus.current = false;
    o.scrollToIndex(focus);
    requestAnimationFrame(() => {
      o.containerRef.current
        ?.querySelector<HTMLElement>(`[data-index="${focus}"]`)
        ?.focus({ preventScroll: true });
    });
  }, [focus, o]);

  const moveTo = useCallback(
    (index: number, extend: boolean) => {
      const next = Math.max(0, Math.min(count - 1, index));
      pendingFocus.current = true;
      setFocus(next);
      if (extend) {
        const from = anchor.current ?? focus;
        const [a, b] = from < next ? [from, next] : [next, from];
        setSelected(new Set(o.ids.slice(a, b + 1)));
      } else {
        anchor.current = next;
      }
    },
    [count, focus, o.ids],
  );

  const toggle = useCallback(
    (index: number) => {
      const id = o.ids[index];
      if (!id) return;
      anchor.current = index;
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [o.ids],
  );

  const selectAll = useCallback(() => {
    setSelected(new Set(o.ids));
    announce(`${o.ids.length} items selected`);
  }, [o.ids]);

  const clear = useCallback(() => setSelected(new Set()), []);

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (count === 0) return;
      const cols = Math.max(1, o.columns);
      const mod = e.metaKey || e.ctrlKey;
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          return moveTo(focus + cols, e.shiftKey);
        case 'ArrowUp':
          e.preventDefault();
          return moveTo(focus - cols, e.shiftKey);
        case 'ArrowRight':
          if (cols > 1) {
            e.preventDefault();
            moveTo(focus + 1, e.shiftKey);
          }
          return;
        case 'ArrowLeft':
          if (cols > 1) {
            e.preventDefault();
            moveTo(focus - 1, e.shiftKey);
          }
          return;
        case 'Home':
          e.preventDefault();
          return moveTo(0, e.shiftKey);
        case 'End':
          e.preventDefault();
          return moveTo(count - 1, e.shiftKey);
        case 'PageDown':
          e.preventDefault();
          return moveTo(focus + cols * 10, e.shiftKey);
        case 'PageUp':
          e.preventDefault();
          return moveTo(focus - cols * 10, e.shiftKey);
        case ' ':
          e.preventDefault();
          return toggle(focus);
        case 'Enter':
          e.preventDefault();
          return o.onOpen(focus);
        case 'Escape':
          if (selected.size) {
            e.preventDefault();
            clear();
          }
          return;
        case 'Delete':
        case 'Backspace': {
          if (!o.onDelete) return;
          e.preventDefault();
          const ids = selected.size ? [...selected] : [o.ids[focus]!];
          return o.onDelete(ids);
        }
        case 'F2':
          e.preventDefault();
          return o.onRename?.(focus);
        case 'ContextMenu':
          e.preventDefault();
          return o.onMenu?.(focus);
        case 'F10':
          if (e.shiftKey) {
            e.preventDefault();
            o.onMenu?.(focus);
          }
          return;
        case 'a':
        case 'A':
          if (mod) {
            e.preventDefault();
            selectAll();
          }
          return;
      }
    },
    [count, focus, moveTo, o, selectAll, selected, toggle, clear],
  );

  const onItemClick = useCallback(
    (index: number, e: MouseEvent) => {
      setFocus(index);
      const id = o.ids[index];
      if (!id) return;
      if (e.shiftKey && anchor.current !== null) {
        const [a, b] = anchor.current < index ? [anchor.current, index] : [index, anchor.current];
        setSelected(new Set(o.ids.slice(a, b + 1)));
        return;
      }
      if (e.metaKey || e.ctrlKey) return toggle(index);
      // Touch: a tap opens (like Files/Drive on phones) unless we're already selecting.
      if (isTouch()) {
        if (selected.size > 0) return toggle(index);
        return o.onOpen(index);
      }
      anchor.current = index;
      setSelected(new Set([id]));
    },
    [o, selected.size, toggle],
  );

  return useMemo(
    () => ({
      selected,
      setSelected,
      focus,
      setFocus,
      toggle,
      selectAll,
      clear,
      onKeyDown,
      onItemClick,
    }),
    [selected, focus, toggle, selectAll, clear, onKeyDown, onItemClick],
  );
}
