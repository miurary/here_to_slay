import type { GameState, PlayerState } from '../../../../shared/types';
import { T, classColor, effectiveClass } from '../game/table/tableUtils';
import { playerColor } from '../pregame/pregameUtils';

interface EndGameProps {
  gameState: GameState;
  myId: string;
  onRematch: () => void;
  onBackToLobby: () => void;
  onLeave: () => void;
}

/** Canonical class order for the winner's chip row / standings dots. */
const WIN_CLASSES = ['bard', 'wizard', 'necromancer', 'berserker', 'guardian', 'thief', 'ranger', 'fighter'];
const RANKS = ['1st', '2nd', '3rd', '4th', '5th', '6th'];

/** Distinct hero classes represented in a player's party, in canonical order. */
function partyClasses(gameState: GameState, player: PlayerState): string[] {
  const present = new Set(
    player.zones.party
      .filter((c) => c.cardType === 'hero')
      .map((c) => effectiveClass(c, gameState, player)?.toLowerCase())
      .filter((c): c is string => !!c),
  );
  return WIN_CLASSES.filter((c) => present.has(c));
}

// Decorative gold sparkles rising behind the winner banner.
const SPARKS = Array.from({ length: 14 }, (_, i) => ({
  left: `${(8 + (i * 6.3) % 84).toFixed(1)}%`,
  size: 3 + (i % 3) * 2,
  dur: `${(2.6 + (i % 5) * 0.5).toFixed(1)}s`,
  delay: `${(i * 0.4).toFixed(1)}s`,
}));

/**
 * Game-over screen content for the shared pre-game shell: winner banner (with
 * win reason + class/monster chips), final standings table, game stats, and the
 * vote-based rematch actions. All values come from the real GameState; the
 * server owns the rematch tally and the lobby transition.
 */
export default function EndGame({ gameState, myId, onRematch, onBackToLobby, onLeave }: EndGameProps) {
  const players = Object.values(gameState.players);
  const winnerId = gameState.winnerId;
  const winner = winnerId ? gameState.players[winnerId] : undefined;
  const target = gameState.targetMonstersToWin ?? 3;
  const youWon = winnerId === myId;

  const winnerName = winner?.username || 'A player';
  const winnerClasses = winner ? partyClasses(gameState, winner) : [];
  const winByMonsters = (winner?.slainMonsters.length ?? 0) >= target;
  const winReason = winByMonsters
    ? `Slew ${winner?.slainMonsters.length} monster${winner && winner.slainMonsters.length !== 1 ? 's' : ''} to claim victory.`
    : `Assembled a party spanning ${winnerClasses.length} hero classes.`;

  // Sort winner-first, then by a simple score (classes + slain weighted).
  const score = (p: PlayerState) => partyClasses(gameState, p).length + p.slainMonsters.length * 2;
  const standings = [...players].sort((a, b) => Number(b.id === winnerId) - Number(a.id === winnerId) || score(b) - score(a));

  // Real end-game stats: duration (start→win), turns, and cards drawn in play.
  const durationMs = gameState.gameStartedAt && gameState.gameEndedAt ? gameState.gameEndedAt - gameState.gameStartedAt : null;
  const durationText = durationMs == null ? null
    : durationMs < 60000 ? `Game lasted ${Math.max(1, Math.round(durationMs / 1000))} seconds`
    : `Game lasted ${Math.round(durationMs / 60000)} minute${Math.round(durationMs / 60000) === 1 ? '' : 's'}`;
  const cardsDrawn = gameState.cardsDrawn ?? 0;
  const gameStats = [
    durationText,
    `${gameState.turnNumber} turn${gameState.turnNumber === 1 ? '' : 's'}`,
    `${cardsDrawn} card${cardsDrawn === 1 ? '' : 's'} drawn`,
  ].filter(Boolean).join(' · ');

  const votes = gameState.rematchVotes ?? [];
  const connected = players.filter((p) => p.connected !== false);
  const iVoted = votes.includes(myId);
  const allIn = connected.length >= 2 && connected.every((p) => votes.includes(p.id));
  const rematchLabel = allIn ? 'Rematch starting…' : iVoted ? 'Waiting for others' : 'Rematch';

  return (
    <>
      {SPARKS.map((sp, i) => (
        <span key={i} style={{ position: 'absolute', bottom: '30%', left: sp.left, width: sp.size, height: sp.size, borderRadius: '50%', background: 'oklch(0.82 0.1 85)', opacity: 0, animation: `gt-sparkle ${sp.dur} ease-out ${sp.delay} infinite`, pointerEvents: 'none' }} />
      ))}

      <div className="gt-scroll" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18, maxHeight: '100%', overflowY: 'auto', padding: 26, boxSizing: 'border-box', zIndex: 1 }}>
        {/* winner banner */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, background: 'oklch(0.2 0.02 260 / 0.94)', border: `1px solid oklch(0.78 0.1 85 / 0.6)`, borderRadius: 16, padding: '22px 44px', boxShadow: '0 24px 60px rgba(0,0,0,0.45), 0 0 40px oklch(0.78 0.1 85 / 0.12)', animation: 'gt-bannerIn 0.4s ease' }}>
          <span className="gt-display" style={{ width: 46, height: 46, borderRadius: '50%', background: T.gold, color: '#1b1d24', display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: 22, animation: 'gt-crownPop 0.5s ease 0.15s backwards' }}>
            {(winnerName[0] ?? '?').toUpperCase()}
          </span>
          <span className="gt-display" style={{ fontWeight: 800, fontSize: 34, color: 'oklch(0.82 0.1 85)', lineHeight: 1.1 }}>{youWon ? 'You win!' : `${winnerName} wins!`}</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{winReason}</span>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', justifyContent: 'center', marginTop: 4 }}>
            {winByMonsters
              ? (winner?.slainMonsters ?? []).map((m) => (
                <span key={m.instanceId} style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', padding: '4px 10px', borderRadius: 999, background: 'oklch(0.28 0.02 260)', color: T.green, border: '1px solid oklch(0.75 0.11 150 / 0.35)' }}>
                  {(gameState.cardTemplates[m.templateId]?.name ?? m.templateId).toUpperCase()}
                </span>
              ))
              : winnerClasses.map((c) => (
                <span key={c} style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', padding: '4px 10px', borderRadius: 999, background: 'oklch(0.28 0.02 260)', color: classColor(c), border: '1px solid transparent' }}>
                  {c.toUpperCase()}
                </span>
              ))}
          </div>
        </div>

        {/* standings */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7, width: 640, maxWidth: '100%' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 14px' }}>
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.18em', color: '#cfd8d0', flex: 1 }}>FINAL STANDINGS</span>
            <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.08em', color: T.muted2, width: 64, textAlign: 'center' }}>CLASSES</span>
            <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.08em', color: T.muted2, width: 64, textAlign: 'center' }}>SLAIN</span>
            <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.08em', color: T.muted2, width: 64, textAlign: 'center' }}>HEROES</span>
          </div>
          {standings.map((p, i) => {
            const isWinner = p.id === winnerId;
            const isMe = p.id === myId;
            const classes = partyClasses(gameState, p);
            const heroCount = p.zones.party.filter((c) => c.cardType === 'hero').length;
            const leaderName = p.partyLeaderId ? gameState.cardTemplates[p.partyLeaderId]?.name : undefined;
            const border = isWinner ? 'oklch(0.78 0.1 85 / 0.55)' : isMe ? 'oklch(0.44 0.02 260)' : T.border;
            return (
              <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'oklch(0.24 0.015 260 / 0.96)', border: `1px solid ${border}`, borderRadius: 11, padding: '10px 14px' }}>
                <span className="gt-display" style={{ fontWeight: 800, fontSize: 15, color: isWinner ? T.gold : T.muted2, width: 22 }}>{RANKS[i]}</span>
                <span style={{ width: 26, height: 26, borderRadius: '50%', display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 11, color: '#1b1d24', background: playerColor(gameState, p, i) }}>
                  {(p.username?.[0] ?? '?').toUpperCase()}
                </span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.username || 'Player'}{isMe ? ' (you)' : ''}</span>
                  <span style={{ fontSize: 10, color: T.muted }}>{leaderName ?? 'No leader'}</span>
                </div>
                <div style={{ display: 'flex', gap: 3, width: 64, justifyContent: 'center', flexWrap: 'wrap' }}>
                  {classes.map((c) => <span key={c} style={{ width: 8, height: 8, borderRadius: 2, background: classColor(c) }} />)}
                </div>
                <span style={{ fontSize: 12, fontWeight: 700, width: 64, textAlign: 'center', color: p.slainMonsters.length ? T.green : T.disabled }}>{p.slainMonsters.length}</span>
                <span style={{ fontSize: 12, fontWeight: 700, width: 64, textAlign: 'center', color: T.text2 }}>{heroCount}</span>
              </div>
            );
          })}
          <div style={{ display: 'flex', justifyContent: 'center', gap: 18, paddingTop: 4 }}>
            <span style={{ fontSize: 10.5, color: '#cfd8d0' }}>{gameStats}</span>
          </div>
        </div>

        {/* actions */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
          <span
            onClick={() => !iVoted && !allIn && onRematch()}
            style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700, background: iVoted || allIn ? 'oklch(0.3 0.015 260)' : T.gold, color: iVoted || allIn ? T.text2 : T.onGold, border: `1px solid ${iVoted || allIn ? 'oklch(0.4 0.02 260)' : T.gold}`, padding: '11px 26px', borderRadius: 9, cursor: iVoted || allIn ? 'default' : 'pointer', transition: 'background 0.25s' }}
          >
            <span>{rematchLabel}</span>
            <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 9px', borderRadius: 999, background: 'rgba(0,0,0,0.18)' }}>{votes.length}/{connected.length}</span>
          </span>
          <span onClick={onBackToLobby} style={{ fontSize: 12, fontWeight: 700, border: '1px solid oklch(0.5 0.06 85)', color: 'oklch(0.82 0.1 85)', padding: '11px 20px', borderRadius: 9, cursor: 'pointer' }}>Back to lobby</span>
          <span onClick={onLeave} style={{ fontSize: 12, fontWeight: 600, color: '#cfd8d0', border: '1px solid rgba(255,255,255,0.25)', padding: '11px 20px', borderRadius: 9, cursor: 'pointer' }}>Leave room</span>
        </div>
        <span style={{ fontSize: 10.5, color: '#cfd8d0' }}>
          {allIn ? 'All players ready — same room, same seats.' : 'A rematch starts when every player is in. “Back to lobby” resets the room now.'}
        </span>
      </div>
    </>
  );
}
