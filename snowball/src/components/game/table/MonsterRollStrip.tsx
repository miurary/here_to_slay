import type { GameState, MonsterAttackResultData } from '../../../../../shared/types';
import { T, dieStyle, goldButton } from './tableUtils';
import ModifierButtons from './ModifierButtons';

interface MonsterRollStripProps {
  gameState: GameState;
  myId: string;
  monsterAttackResult: MonsterAttackResultData | null;
  onClearMonsterResult: () => void;
  onPlayModifier: (modifierInstanceId: string, choiceIndex: number) => void;
  onPassModifier: () => void;
}

const shell: React.CSSProperties = {
  alignSelf: 'center', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', justifyContent: 'center',
  background: 'oklch(0.2 0.02 260 / 0.94)', border: `1px solid oklch(0.78 0.1 85 / 0.5)`,
  borderRadius: 12, padding: '10px 18px', animation: 'gt-toastIn 0.25s ease', maxWidth: 940,
};

/**
 * Felt strip for MY monster attack. The server rolls immediately on attack, so
 * there is no "offer to roll" step — this shows the live modifier window
 * (running total, my modifier buttons) and then the attack result.
 */
export default function MonsterRollStrip({ gameState, myId, monsterAttackResult, onClearMonsterResult, onPlayModifier, onPassModifier }: MonsterRollStripProps) {
  const mPhase = gameState.modifierPhase;

  if (mPhase && mPhase.rollingPlayerId === myId && mPhase.rollType === 'monster_attack') {
    const succeeding = mPhase.slayOnLow ? mPhase.currentTotal <= mPhase.requiredRoll : mPhase.currentTotal >= mPhase.requiredRoll;
    const myTurn = mPhase.activePlayerId === myId;
    const myModifiers = gameState.players[myId]?.zones.hand.filter((c) => c.cardType === 'modifier') ?? [];
    return (
      <div style={shell}>
        <span style={{ ...dieStyle, animation: 'gt-dicePop 0.4s ease' }}>{mPhase.die1}</span>
        <span style={{ ...dieStyle, animation: 'gt-dicePop 0.45s ease' }}>{mPhase.die2}</span>
        <span style={{ fontSize: 12.5, color: T.text2 }}>
          you attack <strong style={{ color: T.gold }}>{mPhase.monsterName ?? 'the monster'}</strong> — <strong style={{ color: '#fff' }}>{mPhase.currentTotal}</strong> / needs {mPhase.requiredRoll}{mPhase.slayOnLow ? ' or less' : '+'} · <strong style={{ color: succeeding ? T.green : T.red }}>{succeeding ? 'succeeding' : 'failing'}</strong>
        </span>
        {mPhase.modifiersPlayed.map((m, i) => (
          <span key={i} style={{ fontSize: 10, fontWeight: 700, padding: '3px 9px', borderRadius: 999, background: T.cardBg2, color: m.amount >= 0 ? T.green : T.red }}>
            {m.playerName} {m.amount >= 0 ? '+' : ''}{m.amount}
          </span>
        ))}
        {myTurn && (
          <>
            <ModifierButtons gameState={gameState} modifiers={myModifiers} rollContext={mPhase.rollContext} onPlay={onPlayModifier} />
            <span onClick={onPassModifier} style={goldButton}>{mPhase.modifiersPlayed.length ? 'Done' : 'Accept result'}</span>
          </>
        )}
        {!myTurn && <span style={{ fontSize: 11, color: T.muted }}>waiting for other players…</span>}
      </div>
    );
  }

  if (monsterAttackResult) {
    const r = monsterAttackResult;
    return (
      <div style={shell}>
        <span style={{ fontSize: 12.5, color: T.text, fontWeight: 600 }}>
          {r.attackerName} rolled <strong style={{ color: '#fff' }}>{r.roll}</strong> against <strong style={{ color: T.gold }}>{r.monsterName}</strong> (needed {r.requiredRoll}{r.slayOnLow ? ' or less' : '+'}) — <strong style={{ color: r.slew ? T.green : T.red }}>{r.slew ? 'slain!' : 'no slay'}</strong>. {r.effectText}
        </span>
        <span onClick={onClearMonsterResult} style={goldButton}>Continue</span>
      </div>
    );
  }

  return null;
}
