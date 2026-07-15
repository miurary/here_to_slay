import type { CardInstance, GameState } from '../../../../../shared/types';
import { T, cardMeta, isPlayableType, goldButton, ghostButton } from './tableUtils';

interface SelectedCardBarProps {
  gameState: GameState;
  myId: string;
  isMyTurn: boolean;
  card: CardInstance | null;
  onPlay: (card: CardInstance) => void;
  onClose: () => void;
}

/**
 * Full-width action bar above the hand for the currently selected hand card:
 * name, type meta, ability text, and a primary action ("Play to party · 1
 * action") — or a note for reactive / unplayable cards.
 */
export default function SelectedCardBar({ gameState, myId, isMyTurn, card, onPlay, onClose }: SelectedCardBarProps) {
  if (!card) return null;
  const template = gameState.cardTemplates[card.templateId];
  const [meta, metaColor] = cardMeta(card, template);
  const ap = gameState.players[myId]?.actionPoints ?? 0;
  const reactive = !isPlayableType(card.cardType);
  const playable = !reactive && isMyTurn && ap >= 1;

  const actionLabel = card.cardType === 'hero' ? 'Play to party · 1 action'
    : card.cardType === 'magic' ? 'Cast · 1 action'
    : 'Play · 1 action';

  const note = reactive
    ? "Reactive — you'll be prompted to play this when a roll or play happens."
    : !isMyTurn ? 'Wait for your turn.'
    : ap < 1 ? 'No actions left this turn.' : '';

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, margin: '0 46px 8px 18px', background: T.cardBg2, border: `1px solid oklch(0.78 0.1 85 / 0.5)`, borderRadius: 10, padding: '9px 14px', flexShrink: 0, animation: 'gt-toastIn 0.2s ease' }}>
      <span style={{ fontWeight: 700, fontSize: 12.5 }}>{template?.name ?? card.templateId}</span>
      <span style={{ fontSize: 10, fontWeight: 700, color: metaColor, letterSpacing: '0.04em' }}>{meta}</span>
      <span style={{ fontSize: 11, color: T.text2, flex: 1 }}>{template?.abilityText ?? ''}</span>
      {playable && (
        <span onClick={() => onPlay(card)} style={goldButton}>{actionLabel}</span>
      )}
      {note && <span style={{ fontSize: 10.5, color: T.muted, whiteSpace: 'nowrap' }}>{note}</span>}
      <span onClick={onClose} style={ghostButton}>Close</span>
    </div>
  );
}
