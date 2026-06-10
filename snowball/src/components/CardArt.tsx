import { useState } from 'react';
import type { CSSProperties } from 'react';

interface CardArtProps {
  /** The card template id, e.g. "h_001". Art is loaded from /cards/<cardId>.png */
  cardId: string;
  /** Display name, used for the alt text and the placeholder label. */
  name?: string;
  className?: string;
  style?: CSSProperties;
}

/**
 * Renders a card's artwork.
 *
 * Convention: drop image files into `snowball/public/cards/` named by the card's
 * id (e.g. `h_001.png`). Vite serves `public/` at the site root, so they resolve
 * at `/cards/<id>.png` in dev and are copied into the deployed build for prod.
 *
 * Cards without art fall back to a labelled placeholder, so it's safe to render
 * this for every card and add the images incrementally.
 */
export default function CardArt({ cardId, name, className, style }: CardArtProps) {
  const [failed, setFailed] = useState(false);

  const baseStyle: CSSProperties = {
    width: '100%',
    aspectRatio: '3 / 4',
    borderRadius: '8px',
    objectFit: 'cover',
    display: 'block',
    ...style,
  };

  if (failed) {
    return (
      <div
        className={className}
        style={{
          ...baseStyle,
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
      style={baseStyle}
      onError={() => setFailed(true)}
    />
  );
}
