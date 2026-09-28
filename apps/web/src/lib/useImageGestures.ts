import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

export interface Gestures {
  /** Called with -1 (previous) or +1 (next) after a sideways swipe. */
  onSwipe: (dir: -1 | 1) => void;
  /** Called after a swipe down (only when not zoomed). */
  onDismiss: () => void;
  /** Whether there's a photo on each side; a swipe towards neither end rubber-bands. */
  canPrev: boolean;
  canNext: boolean;
}

export interface GestureState {
  scale: number;
  x: number;
  y: number;
  /** Sideways/downward drag while not zoomed, for the follow-the-finger effect. */
  dragX: number;
  dragY: number;
  /** True while a finger is down: transitions are off so the image tracks it exactly. */
  active: boolean;
}

const MAX_SCALE = 4;
const DOUBLE_TAP_MS = 300;
const SWIPE_PX = 60;
const DISMISS_PX = 110;

type Point = { x: number; y: number };
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const midpoint = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

const REST: GestureState = { scale: 1, x: 0, y: 0, dragX: 0, dragY: 0, active: false };

/**
 * Photo-viewer gestures with pointer events (touch, pen and mouse alike): pinch to zoom the
 * photo (not the page), drag to pan when zoomed, double-tap to zoom in/out, swipe sideways
 * for the next/previous photo and swipe down to close. The element needs `touch-action: none`
 * so the browser leaves these gestures to us.
 */
export function useImageGestures(resetKey: unknown, g: Gestures) {
  const [state, setRendered] = useState<GestureState>(REST);
  // The live value, so pointer handlers never act on a stale render (and never run side
  // effects inside a state updater, which React may call twice).
  const cur = useRef<GestureState>(REST);
  const setState = useCallback((next: GestureState) => {
    cur.current = next;
    setRendered(next);
  }, []);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const start = useRef<{
    state: GestureState;
    dist: number;
    mid: { x: number; y: number };
    at: { x: number; y: number };
    time: number;
  } | null>(null);
  const lastTap = useRef<{ time: number; x: number; y: number } | null>(null);
  const moved = useRef(false);
  const box = useRef<HTMLElement | null>(null);
  const latest = useRef(g);
  latest.current = g;

  // A new photo starts un-zoomed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset whenever the photo changes
  useEffect(() => setState(REST), [resetKey, setState]);

  const clampPan = useCallback((s: GestureState): GestureState => {
    const el = box.current;
    if (!el || s.scale <= 1) return { ...s, scale: Math.max(1, s.scale), x: 0, y: 0 };
    const w = el.clientWidth;
    const h = el.clientHeight;
    const maxX = ((s.scale - 1) * w) / 2;
    const maxY = ((s.scale - 1) * h) / 2;
    return {
      ...s,
      x: Math.min(maxX, Math.max(-maxX, s.x)),
      y: Math.min(maxY, Math.max(-maxY, s.y)),
    };
  }, []);

  const pts = () => [...pointers.current.values()];

  function begin(current: GestureState) {
    const p = pts();
    start.current = {
      state: current,
      dist: p.length > 1 ? distance(p[0]!, p[1]!) : 0,
      mid: p.length > 1 ? midpoint(p[0]!, p[1]!) : p[0]!,
      at: p[0]!,
      time: Date.now(),
    };
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    box.current = e.currentTarget;
    try {
      // Keep receiving this finger's moves even if it leaves the photo.
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) moved.current = false;
    begin(cur.current);
    setState({ ...cur.current, active: true });
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    if (!pointers.current.has(e.pointerId) || !start.current) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const p = pts();
    const s0 = start.current;
    if (p.length >= 2 && s0.dist > 0) {
      // Pinch: scale about the fingers' midpoint.
      moved.current = true;
      const mid = midpoint(p[0]!, p[1]!);
      const scale = Math.min(
        MAX_SCALE,
        Math.max(0.8, (s0.state.scale * distance(p[0]!, p[1]!)) / s0.dist),
      );
      setState(
        clampPan({
          ...s0.state,
          scale,
          x: s0.state.x + (mid.x - s0.mid.x),
          y: s0.state.y + (mid.y - s0.mid.y),
          dragX: 0,
          dragY: 0,
          active: true,
        }),
      );
      return;
    }
    const dx = e.clientX - s0.at.x;
    const dy = e.clientY - s0.at.y;
    if (Math.hypot(dx, dy) > 8) moved.current = true;
    if (s0.state.scale > 1) {
      setState(clampPan({ ...s0.state, x: s0.state.x + dx, y: s0.state.y + dy, active: true }));
    } else {
      const { canPrev, canNext } = latest.current;
      // Resist at the ends, like the Photos app.
      const edge = (dx > 0 && !canPrev) || (dx < 0 && !canNext);
      const horizontal = Math.abs(dx) > Math.abs(dy);
      setState({
        ...REST,
        dragX: horizontal ? (edge ? dx / 4 : dx) : 0,
        dragY: !horizontal && dy > 0 ? dy : 0,
        active: true,
      });
    }
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.delete(e.pointerId);
    const s0 = start.current;
    if (pointers.current.size > 0) {
      // One finger lifted mid-pinch: carry on panning from here with the other.
      begin(cur.current);
      return;
    }
    const s = cur.current;
    const settled = clampPan({ ...s, active: false });
    if (settled.scale <= 1.02 && s0) {
      setState(REST);
      const { onSwipe, onDismiss, canPrev, canNext } = latest.current;
      const fast = Date.now() - s0.time < 250;
      if (s.dragX < -SWIPE_PX || (fast && s.dragX < -25)) {
        if (canNext) onSwipe(1);
      } else if (s.dragX > SWIPE_PX || (fast && s.dragX > 25)) {
        if (canPrev) onSwipe(-1);
      } else if (s.dragY > DISMISS_PX) {
        onDismiss();
      }
    } else {
      setState(settled);
    }

    // Double-tap to zoom in on that spot, or back out.
    if (!moved.current) {
      const now = Date.now();
      const prev = lastTap.current;
      if (
        prev &&
        now - prev.time < DOUBLE_TAP_MS &&
        Math.hypot(prev.x - e.clientX, prev.y - e.clientY) < 30
      ) {
        lastTap.current = null;
        const el = e.currentTarget;
        const r = el.getBoundingClientRect();
        setState(
          cur.current.scale > 1
            ? REST
            : clampPan({
                ...REST,
                scale: 2.5,
                x: (r.left + r.width / 2 - e.clientX) * 1.5,
                y: (r.top + r.height / 2 - e.clientY) * 1.5,
              }),
        );
      } else {
        lastTap.current = { time: now, x: e.clientX, y: e.clientY };
      }
    }
  };

  return {
    state,
    zoomed: state.scale > 1,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
    },
  };
}
