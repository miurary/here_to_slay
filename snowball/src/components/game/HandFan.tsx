import { useState } from 'react';
import type { GameState } from '../../../../shared/types';
import CardArt from '../CardArt';

interface HandFanProps {
    gameState: GameState;
    myId: string;
    /** Open the card-detail modal for a clicked card. */
    onCardClick: (instanceId: string) => void;
}

// Standard-card display size (matches CardArt's standard width and ~5:7 ratio).
const CARD_W = 132;
const CARD_H = 185;
const GAP = 10;
const MAX_SIDE_BY_SIDE = 5; // up to this many fit without overlapping
const RAISE = 26;           // how far the hovered card lifts

/**
 * The player's hand, always visible as a fanned row of cards. Up to five cards
 * sit side by side; beyond that they overlap to stay within the same footprint.
 * Hovering a card lifts it, spreads its neighbours aside, and reveals its full
 * face. A click opens the card-detail modal (handled by the parent).
 */
export default function HandFan({ gameState, myId, onCardClick }: HandFanProps) {
    const [hovered, setHovered] = useState<number | null>(null);
    const cards = gameState.players[myId]?.zones.hand ?? [];
    const n = cards.length;

    if (n === 0) {
        return <div style={{ alignSelf: 'center', color: '#94a3b8', fontSize: '0.9rem', padding: '0 1rem' }}>Your hand is empty.</div>;
    }

    const fullWidth = MAX_SIDE_BY_SIDE * CARD_W + (MAX_SIDE_BY_SIDE - 1) * GAP;
    const step = n <= MAX_SIDE_BY_SIDE ? CARD_W + GAP : (fullWidth - CARD_W) / (n - 1);
    const containerWidth = (n - 1) * step + CARD_W;
    const overlap = Math.max(0, CARD_W - step);
    const spread = overlap / 2 + 14; // push neighbours far enough to fully reveal the hovered card

    return (
        <div
            onMouseLeave={() => setHovered(null)}
            style={{ position: 'relative', width: containerWidth, height: CARD_H + RAISE, flexShrink: 0 }}
        >
            {cards.map((card, i) => {
                const template = gameState.cardTemplates[card.templateId];
                const isHovered = hovered === i;
                let tx = 0;
                let ty = 0;
                let scale = 1;
                if (hovered !== null) {
                    if (i < hovered) tx = -spread;
                    else if (i > hovered) tx = spread;
                    if (isHovered) { ty = -RAISE; scale = 1.08; }
                }
                return (
                    <div
                        key={card.instanceId}
                        onMouseEnter={() => setHovered(i)}
                        onClick={(e) => { e.stopPropagation(); onCardClick(card.instanceId); }}
                        style={{
                            position: 'absolute',
                            left: i * step,
                            bottom: 0,
                            width: CARD_W,
                            transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
                            transformOrigin: 'bottom center',
                            transition: 'transform 0.16s ease, filter 0.16s ease',
                            zIndex: isHovered ? 1000 : i,
                            cursor: 'pointer',
                            filter: isHovered ? 'drop-shadow(0 14px 22px rgba(0,0,0,0.4))' : 'none',
                        }}
                    >
                        <CardArt cardId={card.templateId} name={template?.name} />
                    </div>
                );
            })}
        </div>
    );
}
