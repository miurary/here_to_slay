import type { GameState } from '../../../../../shared/types';
import { T, classColor, initialOf } from './tableUtils';

interface SeatBarProps {
  gameState: GameState;
  myId: string;
  onInspect: (playerId: string) => void;
  onLeave: () => void;
}

/**
 * Top seat bar: logo, one compact chip per opponent (click to inspect), and a
 * Leave button. Opponents are every player but me, in seat order; the active
 * player's chip is highlighted gold.
 */
export default function SeatBar({ gameState, myId, onInspect, onLeave }: SeatBarProps) {
  const opponents = Object.values(gameState.players).filter((p) => p.id !== myId);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 18px', background: T.headerBg, flexShrink: 0 }}>
      <div className="gt-display" style={{ fontWeight: 800, fontSize: 16, color: T.gold, letterSpacing: '0.02em' }}>GUYSEB</div>

      <div style={{ flex: 1, display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
        {opponents.map((opp) => {
          const leaderCls = opp.partyLeaderId ? gameState.cardTemplates[opp.partyLeaderId]?.class : undefined;
          const color = classColor(leaderCls);
          const active = gameState.activePlayerId === opp.id;
          const name = opp.username || 'Player';
          const away = opp.connected === false;
          const minis = opp.zones.party
            .filter((c) => c.cardType === 'hero')
            .map((c) => classColor(gameState.cardTemplates[c.templateId]?.class))
            .slice(0, 6);
          return (
            <div
              key={opp.id}
              onClick={() => onInspect(opp.id)}
              title={`Inspect ${name}`}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                background: T.cardBg, borderRadius: 10, padding: '7px 12px',
                border: `1px solid ${active ? T.gold : T.border}`,
                boxShadow: active ? 'oklch(0.78 0.1 85 / 0.35) 0 0 14px' : 'none',
                cursor: 'pointer', transition: 'border-color 0.3s, box-shadow 0.3s',
                opacity: away ? 0.55 : 1,
              }}
            >
              <span style={{ width: 24, height: 24, borderRadius: '50%', color: '#1b1d24', display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 11, background: color }}>
                {initialOf(name)}
              </span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontWeight: 700, fontSize: 11.5 }}>{name}{away ? ' · reconnecting…' : ''}</span>
                <span style={{ display: 'flex', gap: 3 }}>
                  {minis.map((c, i) => (
                    <span key={i} style={{ width: 7, height: 7, borderRadius: 2, background: c }} />
                  ))}
                </span>
              </div>
              <span style={{ fontSize: 9.5, color: T.muted }}>H{opp.zones.hand.length} · S{opp.slainMonsters?.length ?? 0}</span>
            </div>
          );
        })}
      </div>

      <span
        onClick={onLeave}
        style={{ fontSize: 11, color: T.muted, border: `1px solid ${T.border}`, padding: '6px 12px', borderRadius: 8, cursor: 'pointer' }}
      >
        Leave
      </span>
    </div>
  );
}
