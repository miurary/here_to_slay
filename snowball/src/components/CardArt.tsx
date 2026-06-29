import { useState } from 'react';
import type { CSSProperties } from 'react';

interface CardArtProps {
  /** The card template id, e.g. "h_001". Art is loaded from /cards/<cardId>.png */
  cardId: string;
  /** Display name, used for the alt text and the placeholder label. */
  name?: string;
  className?: string;
  /** Extra style (e.g. margins). Width is owned by CardArt and should not be overridden. */
  style?: CSSProperties;
}

/**
 * Renders a card's artwork at a uniform size per card class.
 *
 * Monster (`m_*`) and Party Leader (`p_*`) cards are physically larger and
 * taller than the standard poker-sized cards, so they get their own (bigger)
 * uniform width. Every card keeps its true aspect ratio — the image is never
 * cropped — so the text printed on the card stays fully readable. The card text
 * is intentionally NOT duplicated in the DOM; players read it from the art.
 *
 * Convention: drop image files into `snowball/public/cards/` named by the card's
 * id (e.g. `h_001.png`); they resolve at `/cards/<id>.png`. Cards without art
 * fall back to a labelled placeholder.
 */
const STANDARD_WIDTH = 132;
const LARGE_WIDTH = 192;

export default function CardArt({ cardId, name, className, style }: CardArtProps) {
  const [failed, setFailed] = useState(false);
  const isLarge = cardId.startsWith('m_') || cardId.startsWith('p_');
  const width = isLarge ? LARGE_WIDTH : STANDARD_WIDTH;
  const aspectRatio = isLarge ? '7 / 12' : '5 / 7';

  const baseStyle: CSSProperties = {
    width,
    borderRadius: 8,
    display: 'block',
    ...style,
  };

  if (failed) {
    return (
      <div
        className={className}
        style={{
          ...baseStyle,
          aspectRatio,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          padding: '0.4rem',
          boxSizing: 'border-box',
          background: 'linear-gradient(135deg, #e2e8f0, #cbd5e1)',
          color: '#475569',
          fontSize: '0.7rem',
          fontWeight: 600,
          lineHeight: 1.2,
        }}
      >
        <span>{name ?? cardId}</span>
      </div>
    );
  }

  return (
    <img
      src={`/cards/${cardId}.png`}
      alt={name ?? cardId}
      className={className}
      style={{ ...baseStyle, height: 'auto' }}
      onError={() => setFailed(true)}
    />
  );
}
