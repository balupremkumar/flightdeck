// useWindowed.ts — scroll/viewport tracking for a fixed-row-height virtual list.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ROW_H, windowRange } from "./windowing";

export function useWindowed(total: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(600);
  const raf = useRef(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setViewport(el.clientHeight || 600);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  const onScroll = useCallback(() => {
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      if (ref.current) setScrollTop(ref.current.scrollTop);
    });
  }, []);

  /** Brings row `i` into view, centring it only if it is currently off-screen. */
  const scrollToRow = useCallback((i: number) => {
    const el = ref.current;
    if (!el || i < 0) return;
    const top = i * ROW_H;
    if (top >= el.scrollTop && top + ROW_H <= el.scrollTop + el.clientHeight) return;
    el.scrollTop = Math.max(0, top - el.clientHeight / 2 + ROW_H / 2);
  }, []);

  return { ref, onScroll, range: windowRange(scrollTop, viewport, total), scrollToRow };
}
