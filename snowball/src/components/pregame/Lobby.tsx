import type { GameState, PlayerState } from '../../../../shared/types';
import { T, displayName } from '../game/table/tableUtils';
import { SEAT_COLORS } from './pregameUtils';

interface LobbyProps {
  gameState: GameState;
  myId: string;
  players: PlayerState[];
  roomCode: string;
  onCopyInvite: () => void;
  onStart: () => void;
  onToggleReady: () => void;
}

const MAX_SEATS = 6;

/**
 * Lobby felt content: big room code + copy invite, a 3×2 seat-chip grid (filled
 * seats show badge/name/HOST-or-READY tag; empty seats are dashed placeholders),
 * and the start/ready control. The host starts once ≥2 players are all ready;
 * everyone else readies up.
 */
export default function Lobby({ gameState, myId, players, roomCode, onCopyInvite, onStart, onToggleReady }: LobbyProps) {
  const leaderId = gameState.lobbyLeaderId;
  const iAmHost = leaderId === myId;
  const everyoneReady = players.every((p) => p.id === leaderId || p.ready);
  const canStart = players.length >= 2 && everyoneReady;
  const amReady = !!players.find((p) => p.id === myId)?.ready;
  const hostName = displayName(gameState, leaderId);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 22 }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.18em', color: '#cfd8d0' }}>ROOM CODE</span>
        <span className="gt-display" style={{ fontWeight: 800, fontSize: 42, letterSpacing: '0.18em', color: 'oklch(0.82 0.1 85)', textShadow: '0 4px 18px rgba(0,0,0,0.4)' }}>{roomCode}</span>
        <span onClick={onCopyInvite} style={{ fontSize: 11, fontWeight: 700, border: '1px solid oklch(0.5 0.06 85)', color: 'oklch(0.82 0.1 85)', padding: '6px 14px', borderRadius: 8, cursor: 'pointer', marginTop: 4 }}>Copy invite link</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 210px)', gap: 10 }}>
        {Array.from({ length: MAX_SEATS }).map((_, i) => {
          const p = players[i];
          if (!p) {
            return (
              <div key={`empty-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 9, borderRadius: 10, padding: '10px 13px', boxSizing: 'border-box', border: '1px dashed rgba(255,255,255,0.28)', opacity: 0.75 }}>
                <span style={{ width: 30, height: 30, borderRadius: '50%', flexShrink: 0, border: '1px dashed rgba(255,255,255,0.35)' }} />
                <span style={{ fontSize: 12.5, fontWeight: 700, color: '#c4ccc6' }}>Waiting for a player…</span>
              </div>
            );
          }
          const isMe = p.id === myId;
          const isHost = p.id === leaderId;
          const away = p.connected === false;
          const tag = isHost ? 'HOST' : p.ready ? 'READY' : null;
          const tagColor = isHost ? T.gold : T.green;
          return (
            <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 9, borderRadius: 10, padding: '10px 13px', boxSizing: 'border-box', background: T.cardBg, border: `1px solid ${isMe ? T.gold : T.border}`, opacity: away ? 0.55 : 1 }}>
              <span style={{ width: 30, height: 30, borderRadius: '50%', flexShrink: 0, display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 13, color: '#1b1d24', background: SEAT_COLORS[i % SEAT_COLORS.length] }}>
                {(p.username?.[0] ?? '?').toUpperCase()}
              </span>
              <span style={{ fontSize: 12.5, fontWeight: 700, flex: 1, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {p.username || 'Player'}{isMe ? ' (you)' : ''}
              </span>
              {away ? (
                <span style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: '0.08em', padding: '3px 8px', borderRadius: 999, background: 'oklch(0.32 0.07 70)', color: '#ffd9a8' }}>AWAY</span>
              ) : tag && (
                <span style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: '0.08em', padding: '3px 8px', borderRadius: 999, background: 'oklch(0.28 0.02 260)', color: tagColor }}>{tag}</span>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
        {iAmHost ? (
          <>
            <span
              onClick={() => canStart && onStart()}
              style={{ fontSize: 13, fontWeight: 700, padding: '11px 34px', borderRadius: 9, background: canStart ? T.gold : 'oklch(0.3 0.015 260)', color: canStart ? T.onGold : T.disabled, cursor: canStart ? 'pointer' : 'default', transition: 'background 0.3s' }}
            >
              Start game
            </span>
            <span style={{ fontSize: 11, color: '#cfd8d0' }}>
              {players.length < 2
                ? 'Need at least 2 players to start. Share the invite link!'
                : !everyoneReady ? 'Waiting for everyone to ready up…'
                : `${players.length} players in — empty seats stay open until you start.`}
            </span>
          </>
        ) : (
          <>
            <span
              onClick={onToggleReady}
              style={{ fontSize: 13, fontWeight: 700, padding: '11px 34px', borderRadius: 9, background: amReady ? T.green : T.gold, color: T.onGold, cursor: 'pointer', transition: 'background 0.3s' }}
            >
              {amReady ? '✓ Ready' : 'Ready up'}
            </span>
            <span style={{ fontSize: 11, color: '#cfd8d0' }}>
              {amReady ? `Waiting for ${hostName} to start the game…` : `Let ${hostName} know you're ready to play.`}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
