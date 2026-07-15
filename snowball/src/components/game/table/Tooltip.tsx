import type { ReactNode } from 'react';

interface TooltipProps {
  /** Tooltip body text; when empty the anchor renders without a tooltip. */
  text?: string;
  children: ReactNode;
  /** Extra style for the inline anchor wrapper. */
  style?: React.CSSProperties;
}

/**
 * A hover tooltip built on the `.gt-tt` / `.gt-ttbox` CSS primitive: the box
 * sits above the anchor and fades in on hover. Rendered inline so it can wrap a
 * card name, a button, or a chip.
 */
export default function Tooltip({ text, children, style }: TooltipProps) {
  if (!text) return <span style={{ display: 'inline-flex', ...style }}>{children}</span>;
  return (
    <span className="gt-tt" style={{ display: 'inline-flex', ...style }}>
      {children}
      <span className="gt-ttbox">{text}</span>
    </span>
  );
}
