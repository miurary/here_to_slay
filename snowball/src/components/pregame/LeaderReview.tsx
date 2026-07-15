import type { GameState } from '../../../../shared/types';
import { T, classColor, displayName } from '../game/table/tableUtils';
import { playerColor, leaderCardOf } from './pregameUtils';

interface LeaderReviewProps {
  gameState: GameState;
  myId: string;
  onBegin: () => void;
  autoAdvanceSeconds: number | null;
}

/**
 * Leader-review felt content: each player's chosen leader panel, the revealed
 * monster row (requirement pills + slay/fail lines), and the "Deal hands &
 * begin" button (host) that advances into the game.
 */
export default function LeaderReview({ gameState, myId, onBegin, autoAdvanceSeconds }: LeaderReviewProps) {
  const players = Object.values(gameState.players);
  const iAmHost = gameState.lobbyLeaderId === myId;

  return (
    <div className="gt-scroll" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20, maxHeight: '100%', overflowY: 'auto', padding: 24, boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', justifyContent: 'center' }}>
        {players.map((p, i) => {
          const leader = leaderCardOf(p);
          const tmpl = leader ? gameState.cardTemplates[leader.templateId] : undefined;
          const color = classColor(tmpl?.class);
          return (
            <div key={p.id} style={{ width: 220, background: 'oklch(0.22 0.015 260 / 0.94)', border: `1px solid ${T.border}`, borderRadius: 12, padding: '13px 15px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 24, height: 24, borderRadius: '50%', display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 11, color: '#1b1d24', background: playerColor(gameState, p, i) }}>
                  {(p.username?.[0] ?? '?').toUpperCase()}
                </span>
                <span style={{ fontSize: 12.5, fontWeight: 700 }}>{p.username || 'Player'}{p.id === myId ? ' (you)' : ''}</span>
              </div>
              <div style={{ background: T.cardBg, border: `1px solid ${color}`, borderRadius: 10, padding: '9px 11px', display: 'flex', flexDirection: 'column', gap: 3 }}>
                <span style={{ fontWeight: 700, fontSize: 12, lineHeight: 1.25 }}>{tmpl?.name ?? 'No leader'}</span>
                <span style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: '0.05em', color }}>LEADER · {(tmpl?.class ?? '').toUpperCase()}</span>
                <span style={{ fontSize: 10, lineHeight: 1.45, color: T.text2, marginTop: 3 }}>{tmpl?.abilityText ?? ''}</span>
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.18em', color: '#cfd8d0' }}>REVEALED MONSTERS</span>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
          {gameState.activeMonsters.map((monster) => {
            const tmpl = gameState.cardTemplates[monster.templateId];
            return (
              <div key={monster.instanceId} style={{ width: 196, background: 'oklch(0.22 0.015 260 / 0.94)', border: `1px solid ${T.border}`, borderRadius: 11, padding: '12px 14px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span className="gt-display" style={{ fontWeight: 700, fontSize: 14 }}>{tmpl?.name ?? monster.templateId}</span>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {(tmpl?.requirements ?? []).map((r, i) => {
                    const isHero = r.class.toLowerCase() === 'hero';
                    return (
                      <span key={i} style={{ fontSize: 8.5, fontWeight: 700, padding: '3px 8px', borderRadius: 999, background: 'oklch(0.28 0.02 260)', color: isHero ? T.text2 : classColor(r.class) }}>
                        {`${r.amount} ${r.class}`.toUpperCase()}
                      </span>
                    );
                  })}
                </div>
                {tmpl?.upperBound != null && (
                  <span style={{ fontSize: 9.5, lineHeight: 1.45, color: T.green }}>{tmpl.upperBound}+: {tmpl.upperBoundText}</span>
                )}
                {tmpl?.lowerBound != null && (
                  <span style={{ fontSize: 9.5, lineHeight: 1.45, color: T.red }}>{tmpl.lowerBound}−: {tmpl.lowerBoundText}</span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {autoAdvanceSeconds != null && (
        <span style={{ fontSize: 11.5, fontWeight: 700, color: T.green }}>Starting in {autoAdvanceSeconds}…</span>
      )}
      {iAmHost ? (
        <span onClick={onBegin} style={{ fontSize: 13, fontWeight: 700, background: T.gold, color: T.onGold, padding: '11px 34px', borderRadius: 9, cursor: 'pointer' }}>Deal hands &amp; begin</span>
      ) : (
        autoAdvanceSeconds == null && (
          <span style={{ fontSize: 11, color: T.muted }}>Waiting for {displayName(gameState, gameState.lobbyLeaderId)} to deal…</span>
        )
      )}
    </div>
  );
}
