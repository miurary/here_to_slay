import { useState } from 'react';
import type { GameState } from '../../../../../shared/types';
import { T, cardMeta, isPlayableType } from './tableUtils';

interface TableHandProps {
  gameState: GameState;
  myId: string;
  isMyTurn: boolean;
  selectedCardId: string | null;
  onSelect: (cardInstanceId: string) => void;
}

/**
 * The player's hand as an overlapping fan of text cards along the bottom.
 * Hovering lifts a card and raises its z-index; playable cards get a gold
 * border and a "PLAY · 1" pill; the selected card lifts and glows gold.
 */
export default function TableHand({ gameState, myId, isMyTurn, selectedCardId, onSelect }: TableHandProps) {
  const [hovered, setHovered] = useState<string | null>(null);
  const hand = gameState.players[myId]?.zones.hand ?? [];
  const ap = gameState.players[myId]?.actionPoints ?? 0;

  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', padding: '0 46px 16px 18px', height: 172, flexShrink: 0 }}>
      <span style={{ fontSize: 10, fontWeight: 700, color: T.muted2, letterSpacing: '0.07em', writingMode: 'vertical-rl', transform: 'rotate(180deg)', marginRight: 14 }}>
        HAND · {hand.length}
      </span>
      <div style={{ display: 'flex', alignItems: 'flex-end', paddingLeft: 26 }} onMouseLeave={() => setHovered(null)}>
        {hand.map((card) => {
          const template = gameState.cardTemplates[card.templateId];
          const [meta, metaColor] = cardMeta(card, template);
          const playable = isPlayableType(card.cardType) && isMyTurn && ap >= 1;
          const selected = selectedCardId === card.instanceId;
          const isHovered = hovered === card.instanceId;
          const lifted = selected || isHovered;
          return (
            <div
              key={card.instanceId}
              onMouseEnter={() => setHovered(card.instanceId)}
              onClick={(e) => { e.stopPropagation(); onSelect(card.instanceId); }}
              style={{
                width: 120, height: 152, marginLeft: -26, background: T.cardBg2, borderRadius: 8, padding: 8,
                cursor: 'pointer', position: 'relative',
                border: `1px solid ${selected ? T.gold : playable ? 'oklch(0.5 0.06 85)' : 'oklch(0.36 0.015 260)'}`,
                transform: lifted ? 'translateY(-16px)' : 'none',
                zIndex: selected ? 15 : isHovered ? 20 : 'auto',
                boxShadow: lifted ? '0 12px 24px rgba(0,0,0,0.5)' : 'none',
                transition: 'transform 0.18s, border-color 0.18s, box-shadow 0.18s',
              }}
            >
              <div style={{ fontWeight: 700, fontSize: 10.5 }}>{template?.name ?? card.templateId}</div>
              <div style={{ fontSize: 8, fontWeight: 700, marginTop: 1, color: metaColor }}>{meta}</div>
              <div style={{ fontSize: 9, color: T.text2, lineHeight: 1.4, marginTop: 4 }}>{template?.abilityText ?? ''}</div>
              {playable && (
                <div style={{ position: 'absolute', bottom: 8, left: 8, fontSize: 8, fontWeight: 700, background: T.gold, color: T.onGold, padding: '2px 7px', borderRadius: 999 }}>PLAY · 1</div>
              )}
            </div>
          );
        })}
        {hand.length === 0 && (
          <div style={{ color: T.muted, fontSize: 12, paddingLeft: 8 }}>Your hand is empty.</div>
        )}
      </div>
    </div>
  );
}
