import type { GameState } from '../../../../../shared/types';
import { T, backdrop, panel, closeButton, cardMeta } from './tableUtils';

interface DiscardOverlayProps {
  gameState: GameState;
  onClose: () => void;
}

/** Centered browser for the discard pile (top of pile first), matching the design. */
export default function DiscardOverlay({ gameState, onClose }: DiscardOverlayProps) {
  const cards = gameState.discardPile;
  return (
    <div style={backdrop} onClick={onClose}>
      <div style={{ ...panel, width: 660, maxHeight: '72vh' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span className="gt-display" style={{ fontWeight: 700, fontSize: 17 }}>Discard pile · {cards.length}</span>
          <span onClick={onClose} style={closeButton}>Close</span>
        </div>
        <span style={{ fontSize: 10.5, color: T.muted2 }}>Top of pile first — some effects let you take cards from here.</span>
        <div className="gt-scroll" style={{ overflowY: 'auto', display: 'flex', flexWrap: 'wrap', gap: 8, alignContent: 'flex-start' }}>
          {cards.length === 0 && <span style={{ fontSize: 11, color: T.muted }}>No cards in the discard pile.</span>}
          {[...cards].reverse().map((card) => {
            const tmpl = gameState.cardTemplates[card.templateId];
            const [meta, metaColor] = cardMeta(card, tmpl);
            return (
              <div key={card.instanceId} style={{ width: 148, background: 'oklch(0.27 0.015 260)', border: '1px solid oklch(0.36 0.015 260)', borderRadius: 8, padding: '8px 9px' }}>
                <div style={{ fontWeight: 700, fontSize: 10.5 }}>{tmpl?.name ?? card.templateId}</div>
                <div style={{ fontSize: 8, fontWeight: 700, color: metaColor, marginTop: 1 }}>{meta}</div>
                <div style={{ fontSize: 9, color: T.text2, lineHeight: 1.4, marginTop: 4 }}>{tmpl?.abilityText ?? ''}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
