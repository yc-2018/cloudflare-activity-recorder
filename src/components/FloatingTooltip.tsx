import { useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface FloatingTooltipProps {
  x: number;
  y: number;
  revision: string | number;
  children: ReactNode;
}

const VIEWPORT_GAP = 8;
const POINTER_GAP = 14;

export function FloatingTooltip({ x, y, revision, children }: FloatingTooltipProps) {
  const elementRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return;

    const width = element.offsetWidth;
    const height = element.offsetHeight;
    let left = x + POINTER_GAP;
    let top = y + POINTER_GAP;
    if (left + width > window.innerWidth - VIEWPORT_GAP) left = x - width - POINTER_GAP;
    if (top + height > window.innerHeight - VIEWPORT_GAP) top = y - height - POINTER_GAP;
    element.style.left = `${Math.max(VIEWPORT_GAP, Math.min(left, window.innerWidth - width - VIEWPORT_GAP))}px`;
    element.style.top = `${Math.max(VIEWPORT_GAP, Math.min(top, window.innerHeight - height - VIEWPORT_GAP))}px`;
  }, [revision, x, y]);

  return createPortal(
    <div
      ref={elementRef}
      className="hover-tooltip"
      role="tooltip"
      style={{ left: x + POINTER_GAP, top: y + POINTER_GAP }}
    >
      {children}
    </div>,
    document.body,
  );
}
