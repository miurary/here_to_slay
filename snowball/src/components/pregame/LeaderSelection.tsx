import { useState } from 'react';
import type { GameState } from '../../../../shared/types';
import { T, displayName } from '../game/table/tableUtils';
import { playerColor, leaderCardOf } from './pregameUtils';

interface LeaderSelectionProps {
  gameState: GameState;
  myId: string;
  onChoose: (instanceId: string) => void;
}

/**
 * Party-leader selection felt content: an instruction pill, a row of face-down
 * leader cards (click to pick, only on your turn), and per-player chips showing
 * who's picking / what they chose. Driven by gameState.availablePartyLeaderCards
 * and currentSelectionPlayerId.
 */
export default function LeaderSelection({ gameState, myId, onChoose }: LeaderSelectionProps) {
  const [hovered, setHovered] = useState<string | null>(null);
  const chooserId = gameState.currentSelectionPlayerId;
  const myTurn = chooserId === myId;
  const players = Object.values(gameState.players);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, background: 'oklch(0.2 0.02 260 / 0.94)', border: `1px solid oklch(0.78 0.1 85 / 0.5)`, borderRadius: 12, padding: '10px 18px' }}>
        <span style={{ fontSize: 12.5, color: T.text, fontWeight: 600 }}>
          {myTurn ? 'Your pick — choose a face-down party leader.' : `${displayName(gameState, chooserId)} is choosing a party leader…`}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
        {gameState.availablePartyLeaderCards.map((card) => {
          const lift = myTurn && hovered === card.instanceId;
          return (
            <div
              key={card.instanceId}
              onMouseEnter={() => setHovered(card.instanceId)}
              onMouseLeave={() => setHovered(null)}
              onClick={() => myTurn && onChoose(card.instanceId)}
              style={{
                width: 108, height: 140, borderRadius: 9,
                background: 'linear-gradient(160deg, oklch(0.3 0.03 285), oklch(0.2 0.025 285))',
                border: `1px solid ${lift ? T.gold : 'oklch(0.42 0.04 285)'}`,
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8,
                cursor: myTurn ? 'pointer' : 'default',
                transform: lift ? 'translateY(-8px)' : 'none',
                boxShadow: lift ? '0 12px 24px rgba(0,0,0,0.45)' : 'none',
                transition: 'transform 0.15s, border-color 0.15s, box-shadow 0.15s',
              }}
            >
              <span className="gt-display" style={{ width: 36, height: 36, borderRadius: '50%', border: '1px solid oklch(0.6 0.08 85 / 0.6)', display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: 15, color: T.gold }}>H</span>
              <span style={{ fontSize: 7.5, fontWeight: 700, letterSpacing: '0.16em', color: T.muted }}>PARTY LEADER</span>
            </div>
          );
        })}
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
        {players.map((p, i) => {
          const leader = leaderCardOf(p);
          const leaderName = leader ? gameState.cardTemplates[leader.templateId]?.name : undefined;
          const pick = leaderName ?? (chooserId === p.id ? 'picking…' : 'waiting');
          return (
            <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, background: T.cardBg, border: `1px solid ${T.border}`, borderRadius: 10, padding: '8px 14px' }}>
              <span style={{ width: 22, height: 22, borderRadius: '50%', display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 10, color: '#1b1d24', background: playerColor(gameState, p, i) }}>
                {(p.username?.[0] ?? '?').toUpperCase()}
              </span>
              <span style={{ fontSize: 12, fontWeight: 700 }}>{p.username || 'Player'}{p.id === myId ? ' (you)' : ''}</span>
              <span style={{ fontSize: 11, fontWeight: 600, color: leaderName ? T.gold : T.muted2 }}>{pick}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
