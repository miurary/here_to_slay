import type { ReactNode } from 'react';
import type { GameState } from '../../../../../shared/types';
import { T, feltBackground, monsterRequirements } from './tableUtils';

interface FeltProps {
  gameState: GameState;
  myId: string;
  isMyTurn: boolean;
  feltColor: string;
  /** Disable monster attacks while a roll/modifier window is already open. */
  rollBusy: boolean;
  toast: string | null;
  onDraw: () => void;
  onMulligan: () => void;
  onOpenDiscard: () => void;
  onAttackMonster: (monsterInstanceId: string) => void;
  /** Roll/prompt strips, pinned bottom-center of the felt by the parent. */
  strips?: ReactNode;
}

/**
 * The green felt: deck + discard piles on the left, the active-monster row
 * centered, a transient toast top-right, and the roll/prompt strips (passed in)
 * pinned along the bottom.
 */
export default function Felt({ gameState, myId, isMyTurn, feltColor, rollBusy, toast, onDraw, onMulligan, onOpenDiscard, onAttackMonster, strips }: FeltProps) {
  const me = gameState.players[myId];
  const ap = me?.actionPoints ?? 0;
  // Mulligan (discard hand, redraw) — server-validated: costs 3 AP, needs ≥5 in deck.
  const canMulligan = isMyTurn && ap >= 3 && gameState.mainDeck.length >= 5;

  return (
    <div style={{ margin: '12px 46px 12px 18px', borderRadius: 18, padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12, position: 'relative', flex: 1, border: '1px solid rgba(255,255,255,0.09)', background: feltBackground(feltColor) }}>
      {toast && (
        <div style={{ position: 'absolute', top: 12, right: 14, background: 'oklch(0.2 0.02 260 / 0.88)', border: '1px solid oklch(0.4 0.02 260)', borderRadius: 8, padding: '6px 12px', fontSize: 10.5, color: '#cfd3db', animation: 'gt-toastIn 0.25s ease', maxWidth: 340, zIndex: 5 }}>
          {toast}
        </div>
      )}

      <div style={{ display: 'flex', gap: 14, alignItems: 'stretch', justifyContent: 'center', flex: 1 }}>
        {/* piles */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, justifyContent: 'center' }}>
          <div
            onClick={() => isMyTurn && ap >= 1 && onDraw()}
            title={isMyTurn ? 'Draw a card (1 action)' : 'Deck'}
            style={{ width: 92, height: 126, borderRadius: 9, background: T.feltPile, border: '1px solid oklch(0.42 0.06 85)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3, cursor: isMyTurn && ap >= 1 ? 'pointer' : 'default' }}
          >
            <span style={{ fontWeight: 700, fontSize: 12 }}>Deck</span>
            <span style={{ fontSize: 10, color: T.muted }}>{gameState.mainDeck.length}</span>
            <span style={{ marginTop: 5, fontSize: 8.5, background: T.gold, color: T.onGold, padding: '2px 7px', borderRadius: 999, fontWeight: 700 }}>DRAW · 1</span>
          </div>
          <div
            onClick={onOpenDiscard}
            title="Browse discard pile"
            style={{ width: 92, height: 44, borderRadius: 9, border: '1px dashed rgba(255,255,255,0.25)', display: 'grid', placeItems: 'center', fontSize: 10, color: '#c4ccc6', cursor: 'pointer' }}
          >
            Discard · {gameState.discardPile.length}
          </div>
          {isMyTurn && (
            <div
              onClick={() => canMulligan && onMulligan()}
              title={canMulligan
                ? 'Discard your hand and draw a fresh one (3 actions)'
                : ap < 3 ? 'Mulligan needs 3 actions' : 'Not enough cards left in the deck to mulligan'}
              style={{
                width: 92, borderRadius: 9, padding: '5px 0', display: 'grid', placeItems: 'center',
                fontSize: 9, fontWeight: 700, letterSpacing: '0.02em', textAlign: 'center',
                border: `1px solid ${canMulligan ? 'oklch(0.5 0.06 85)' : 'oklch(0.34 0.015 260)'}`,
                color: canMulligan ? T.gold : T.disabled,
                cursor: canMulligan ? 'pointer' : 'not-allowed',
              }}
            >
              Mulligan · 3
            </div>
          )}
        </div>

        {/* monsters */}
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', justifyContent: 'center' }}>
          {gameState.activeMonsters.map((monster) => {
            const tmpl = gameState.cardTemplates[monster.templateId];
            const { met, reqs } = monsterRequirements(me, tmpl, gameState);
            const canAttack = met && isMyTurn && ap >= 2 && !rollBusy;
            const badge = canAttack ? 'ATTACK · 2 ACTIONS' : met ? 'REQUIREMENTS MET' : 'LOCKED';
            return (
              <div
                key={monster.instanceId}
                onClick={() => canAttack && onAttackMonster(monster.instanceId)}
                style={{
                  width: 216, background: T.feltPile, borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 7,
                  border: `1px solid ${canAttack ? 'oklch(0.78 0.1 85 / 0.7)' : 'oklch(0.34 0.02 260)'}`,
                  opacity: met ? 1 : 0.75,
                  boxShadow: canAttack ? '0 0 18px oklch(0.78 0.1 85 / 0.25)' : 'none',
                  cursor: canAttack ? 'pointer' : 'default', transition: 'box-shadow 0.2s, transform 0.15s',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 6 }}>
                  <span className="gt-display" style={{ fontWeight: 700, fontSize: 15 }}>{tmpl?.name ?? monster.templateId}</span>
                  <span style={{ fontSize: 9, padding: '2px 7px', borderRadius: 999, fontWeight: 700, whiteSpace: 'nowrap', background: canAttack ? T.gold : 'oklch(0.3 0.02 260)', color: canAttack ? T.onGold : T.muted }}>{badge}</span>
                </div>
                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                  {reqs.map((r, i) => (
                    <span key={i} style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, fontWeight: 700, background: T.cardBg2, color: r.met ? T.green : T.red }}>{r.text}</span>
                  ))}
                </div>
                <div style={{ fontSize: 10.5, lineHeight: 1.5 }}>
                  <strong style={{ color: T.green }}>{tmpl?.upperBound}+</strong> {tmpl?.upperBoundText}
                  {tmpl?.lowerBound != null && (
                    <><br /><strong style={{ color: T.red }}>{tmpl.lowerBound}−</strong> {tmpl.lowerBoundText}</>
                  )}
                </div>
                {tmpl?.slainEffectText && (
                  <div style={{ fontSize: 9.5, color: T.muted2, borderTop: '1px solid oklch(0.32 0.02 260)', paddingTop: 6, lineHeight: 1.4 }}>
                    Slain: {tmpl.slainEffectText}
                  </div>
                )}
              </div>
            );
          })}
          {gameState.activeMonsters.length === 0 && (
            <div style={{ alignSelf: 'center', color: T.muted, fontSize: 12 }}>No active monsters.</div>
          )}
        </div>
      </div>

      {strips}
    </div>
  );
}
