import type { GameState } from '../../../../shared/types';
import { T, dieStyle, goldButton, displayName } from '../game/table/tableUtils';
import { SEAT_COLORS } from './pregameUtils';

interface RollForFirstProps {
  gameState: GameState;
  myId: string;
  /** 'rolling' shows the gold roll pill; 'roll_complete' the green winner pill. */
  status: 'rolling' | 'roll_complete';
  isRolling: boolean;
  myRoll: number | null;
  onRoll: () => void;
  onContinue: () => void;
  autoAdvanceSeconds: number | null;
}

/** Derive a plausible die pair that sums to a rolled total (server only sends totals). */
function faces(total: number): [number, number] {
  const d1 = Math.min(6, Math.max(1, total - 1));
  return [d1, total - d1];
}

/**
 * Roll-for-first-player felt content: a roll-strip pill (dice + status + Roll
 * button, or the winner announcement + countdown) above one result chip per
 * player. Driven by gameState.currentRollerId / diceRolls / rollWinnerId.
 */
export default function RollForFirst({ gameState, myId, status, isRolling, myRoll, onRoll, onContinue, autoAdvanceSeconds }: RollForFirstProps) {
  const players = Object.values(gameState.players);
  const rollerId = gameState.currentRollerId;
  const winnerId = gameState.rollWinnerId;
  const isResult = status === 'roll_complete';
  const canRoll = !isResult && rollerId === myId && myRoll == null && !isRolling;

  const rollText = isRolling ? 'Rolling…'
    : rollerId === myId && myRoll == null ? 'Roll two dice — highest total goes first. Your roll!'
    : myRoll != null && rollerId === myId ? `You rolled ${myRoll}.`
    : rollerId ? `Waiting for ${displayName(gameState, rollerId)} to roll…`
    : 'Comparing rolls…';

  const dice = myRoll != null ? faces(myRoll) : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: isResult ? 16 : 18 }}>
      {isResult ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, background: 'oklch(0.2 0.02 260 / 0.94)', border: `1px solid oklch(0.75 0.11 150 / 0.55)`, borderRadius: 12, padding: '14px 22px', animation: 'gt-toastIn 0.25s ease' }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>
            {winnerId ? `${displayName(gameState, winnerId)} rolled highest and goes first!` : 'All players have rolled.'}
          </span>
          {autoAdvanceSeconds != null && <span style={{ fontSize: 11.5, color: T.green, fontWeight: 700 }}>Continuing in {autoAdvanceSeconds}…</span>}
          {gameState.lobbyLeaderId === myId && <span onClick={onContinue} style={goldButton}>Continue now</span>}
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, background: 'oklch(0.2 0.02 260 / 0.94)', border: `1px solid oklch(0.78 0.1 85 / 0.5)`, borderRadius: 12, padding: '12px 20px', animation: 'gt-toastIn 0.25s ease' }}>
          {dice && (
            <>
              <span style={{ ...dieStyle, animation: 'gt-dicePop 0.4s ease' }}>{dice[0]}</span>
              <span style={{ ...dieStyle, animation: 'gt-dicePop 0.45s ease' }}>{dice[1]}</span>
            </>
          )}
          <span style={{ fontSize: 12.5, color: T.text2 }}>{rollText}</span>
          {canRoll && <span onClick={onRoll} style={goldButton}>Roll dice</span>}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
        {players.map((p, i) => {
          const total = gameState.diceRolls[p.id];
          const isWinner = isResult && p.id === winnerId;
          return (
            <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, background: T.cardBg, border: `1px solid ${isWinner ? 'oklch(0.75 0.11 150 / 0.6)' : T.border}`, borderRadius: 10, padding: '8px 14px' }}>
              <span style={{ width: 22, height: 22, borderRadius: '50%', display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 10, color: '#1b1d24', background: SEAT_COLORS[i % SEAT_COLORS.length] }}>
                {(p.username?.[0] ?? '?').toUpperCase()}
              </span>
              <span style={{ fontSize: 12, fontWeight: 700 }}>{p.username || 'Player'}{p.id === myId ? ' (you)' : ''}</span>
              <span style={{ fontSize: 14, fontWeight: 700, color: isWinner ? T.green : total != null ? T.text : T.disabled }}>
                {total != null ? total : '…'}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
