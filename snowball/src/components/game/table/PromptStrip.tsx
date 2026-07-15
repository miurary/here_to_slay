import type { CardInstance, ChallengeResolvedData, GameState } from '../../../../../shared/types';
import { T, dieStyle, goldButton, ghostButton, displayName } from './tableUtils';
import ModifierButtons from './ModifierButtons';
import Tooltip from './Tooltip';

interface PromptStripProps {
  gameState: GameState;
  myId: string;
  challengeResult: ChallengeResolvedData | null;
  eligibleChallengeCards: CardInstance[];
  onClearChallengeResult: () => void;
  onPlayChallenge: (cardInstanceId: string) => void;
  onPassChallenge: () => void;
  onPlayModifier: (modifierInstanceId: string, choiceIndex: number) => void;
  onPassModifier: () => void;
}

const shell: React.CSSProperties = {
  alignSelf: 'center', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', justifyContent: 'center',
  background: 'oklch(0.2 0.02 260 / 0.94)', border: `1px solid oklch(0.68 0.15 25 / 0.55)`,
  borderRadius: 12, padding: '10px 18px', animation: 'gt-toastIn 0.25s ease', maxWidth: 940,
};

const goldName: React.CSSProperties = {
  color: T.gold, textDecoration: 'underline dotted', textUnderlineOffset: 3, cursor: 'help',
};

/**
 * Reactive prompt strip pinned to the felt (red-tinted). Shows, in priority
 * order: a challenge roll-off result, an opponent's modifier window (with my
 * modifier buttons), a challenge decision on an opponent's play, or a "waiting"
 * note while my own play is being challenged. Returns null when nothing applies.
 */
export default function PromptStrip(props: PromptStripProps) {
  const { gameState, myId, challengeResult, eligibleChallengeCards,
    onClearChallengeResult, onPlayChallenge, onPassChallenge, onPlayModifier, onPassModifier } = props;

  // 1) Challenge roll-off result.
  if (challengeResult) {
    const cr = challengeResult;
    const resolved = cr.challengerWon
      ? `challenge succeeds, ${cr.cardName} is discarded`
      : `challenge fails, ${cr.cardName} resolves`;
    return (
      <div style={shell}>
        <span style={{ fontSize: 12.5, color: T.text, fontWeight: 600 }}>
          {cr.challengerName} rolled {cr.challengerTotalRoll} · {cr.challengedName} rolled {cr.challengedRoll} — {resolved}
        </span>
        <span onClick={onClearChallengeResult} style={goldButton}>Continue</span>
      </div>
    );
  }

  // 2) Opponent's roll → my modifier window (my roll is handled by RollStrip).
  const mPhase = gameState.modifierPhase;
  if (mPhase && mPhase.rollingPlayerId !== myId) {
    const roller = displayName(gameState, mPhase.rollingPlayerId);
    const target = mPhase.monsterName ?? gameState.cardTemplates[gameState.players[mPhase.rollingPlayerId]?.zones.party.find((c) => c.instanceId === mPhase.heroInstanceId)?.templateId ?? '']?.name ?? 'their roll';
    const myTurn = mPhase.activePlayerId === myId;
    const myModifiers = gameState.players[myId]?.zones.hand.filter((c) => c.cardType === 'modifier') ?? [];
    return (
      <div style={shell}>
        <span style={{ ...dieStyle, animation: 'gt-dicePop 0.4s ease' }}>{mPhase.die1}</span>
        <span style={{ ...dieStyle, animation: 'gt-dicePop 0.45s ease' }}>{mPhase.die2}</span>
        <span style={{ fontSize: 12.5, color: T.text, fontWeight: 600 }}>
          {roller} rolls for <span style={goldName}>{target}</span> — <strong style={{ color: '#fff' }}>{mPhase.currentTotal}</strong> / needs {mPhase.requiredRoll}{mPhase.slayOnLow ? ' or less' : '+'}
        </span>
        {mPhase.modifiersPlayed.map((m, i) => (
          <span key={i} style={{ fontSize: 10, fontWeight: 700, padding: '3px 9px', borderRadius: 999, background: T.cardBg2, color: m.amount >= 0 ? T.green : T.red }}>
            {m.playerName} {m.amount >= 0 ? '+' : ''}{m.amount}
          </span>
        ))}
        {myTurn ? (
          <>
            <ModifierButtons gameState={gameState} modifiers={myModifiers} rollContext={mPhase.rollContext} onPlay={onPlayModifier} />
            <span onClick={onPassModifier} style={goldButton}>{mPhase.modifiersPlayed.length ? 'Done' : 'Pass'}</span>
          </>
        ) : (
          <span style={{ fontSize: 11, color: T.muted }}>waiting for {displayName(gameState, mPhase.activePlayerId)}…</span>
        )}
      </div>
    );
  }

  // 3) An opponent's play I may challenge.
  const pc = gameState.pendingChallenge;
  if (pc && pc.eligibleChallengerIds.includes(myId)) {
    const who = displayName(gameState, pc.pendingPlayerId);
    return (
      <div style={shell}>
        <span style={{ fontSize: 12.5, color: T.text, fontWeight: 600 }}>
          {who} plays <span style={goldName}>{pc.pendingCardName}</span> — challenge it?
        </span>
        {eligibleChallengeCards.map((card) => {
          const tmpl = gameState.cardTemplates[card.templateId];
          return (
            <Tooltip key={card.instanceId} text={`${tmpl?.name ?? 'Challenge'} — ${(tmpl?.abilityText as string) ?? ''}`}>
              <span onClick={() => onPlayChallenge(card.instanceId)} style={goldButton}>Challenge ({tmpl?.name ?? 'card'})</span>
            </Tooltip>
          );
        })}
        <span onClick={onPassChallenge} style={ghostButton}>Allow</span>
      </div>
    );
  }

  // 4) My own play is pending challenge — nothing to do but wait.
  if (pc && pc.pendingPlayerId === myId) {
    return (
      <div style={shell}>
        <span style={{ fontSize: 12.5, color: T.text, fontWeight: 600 }}>
          Your <span style={goldName}>{pc.pendingCardName}</span> — waiting for opponents to respond…
        </span>
      </div>
    );
  }

  return null;
}
