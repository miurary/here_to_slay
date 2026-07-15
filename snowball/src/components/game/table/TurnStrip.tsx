import type { GameState } from '../../../../../shared/types';
import { T, displayName } from './tableUtils';

interface TurnStripProps {
  gameState: GameState;
  myId: string;
}

/** Base action points a turn starts with — drives how many AP pips to draw. */
const AP_PIPS = 3;

/**
 * Centered turn pill. On my turn it's gold with AP pips (filled = available,
 * outlined = spent) and an "N actions left" label; otherwise a muted pill
 * naming whose turn it is.
 */
export default function TurnStrip({ gameState, myId }: TurnStripProps) {
  const isMyTurn = gameState.activePlayerId === myId;
  const ap = gameState.players[myId]?.actionPoints ?? 0;
  const pipCount = Math.max(AP_PIPS, ap);

  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: '12px 0 0', flexShrink: 0 }}>
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 12, padding: '8px 20px', borderRadius: 999,
          fontWeight: 700, fontSize: 14, transition: 'background 0.3s',
          background: isMyTurn ? T.gold : 'oklch(0.3 0.015 260)',
          color: isMyTurn ? T.onGold : T.text2,
        }}
      >
        {isMyTurn ? 'YOUR TURN' : `${displayName(gameState, gameState.activePlayerId).toUpperCase()}'S TURN`}
        {isMyTurn && (
          <span style={{ display: 'flex', gap: 5 }}>
            {Array.from({ length: pipCount }).map((_, i) => {
              const filled = i < ap;
              return (
                <span
                  key={i}
                  style={{
                    width: 11, height: 11, borderRadius: '50%', boxSizing: 'border-box',
                    background: filled ? T.onGold : 'transparent',
                    border: `2px solid ${filled ? T.onGold : 'oklch(0.2 0.02 85 / 0.45)'}`,
                  }}
                />
              );
            })}
          </span>
        )}
        <span style={{ fontSize: 11.5, fontWeight: 600, opacity: 0.8 }}>
          {isMyTurn ? `${ap} action${ap === 1 ? '' : 's'} left` : 'waiting…'}
        </span>
      </div>
    </div>
  );
}
