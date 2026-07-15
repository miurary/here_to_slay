import { useState } from 'react';
import type { CardInstance, GameState } from '../../../../../shared/types';
import { T, dieStyle, goldButton, ghostButton, cardMeta } from './tableUtils';
import ModifierButtons from './ModifierButtons';

interface RollStripProps {
  gameState: GameState;
  myId: string;
  hero: CardInstance;
  /** 'play' = a hero just played from hand (offer to roll first); 'party' = activate a party hero. */
  mode: 'play' | 'party';
  isMyTurn: boolean;
  isHeroRolling: boolean;
  rolledDice: { die1: number; die2: number } | null;
  /** Server's roll-result message for this hero (or null before it resolves). */
  resultMessage: string | null;
  pendingHeroAbilityActivationId: string | null;
  onRollPlay: () => void;
  onSkipPlay: () => void;
  onRollParty: () => void;
  onActivate: (heroInstanceId: string) => void;
  onPlayModifier: (modifierInstanceId: string, choiceIndex: number) => void;
  onPassModifier: () => void;
  onClose: () => void;
}

const shell: React.CSSProperties = {
  alignSelf: 'center', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', justifyContent: 'center',
  background: 'oklch(0.2 0.02 260 / 0.94)', border: `1px solid oklch(0.78 0.1 85 / 0.5)`,
  borderRadius: 12, padding: '10px 18px', animation: 'gt-toastIn 0.25s ease', maxWidth: 940,
};

/**
 * Non-blocking roll strip pinned to the felt for MY hero-ability roll. Walks the
 * same states the old HeroAbilityModal did — offer/roll → animate → modifier
 * window → activate — but rendered inline, and surfaces the server modifier
 * phase (running total, played chips, my own modifier buttons) while it's open.
 */
export default function RollStrip(props: RollStripProps) {
  const { gameState, myId, hero, mode, isMyTurn, isHeroRolling, rolledDice, resultMessage,
    pendingHeroAbilityActivationId, onRollPlay, onSkipPlay, onRollParty, onActivate,
    onPlayModifier, onPassModifier, onClose } = props;

  const template = gameState.cardTemplates[hero.templateId];
  const heroName = template?.name ?? 'Hero';
  const [meta] = cardMeta(hero, template);

  // Whether a roll has been started for this prompt (parent keys us by hero+mode
  // so this resets when the strip opens for a different hero).
  const [rolled, setRolled] = useState(false);
  const startRoll = () => { setRolled(true); if (mode === 'play') onRollPlay(); else onRollParty(); };

  const mPhase = gameState.modifierPhase;
  const modifierPhaseActive = !!mPhase && mPhase.rollingPlayerId === myId;
  const myModifierTurn = modifierPhaseActive && mPhase!.activePlayerId === myId;
  const canActivate = rolled && !isHeroRolling && !modifierPhaseActive && pendingHeroAbilityActivationId === hero.instanceId;

  const dice = mPhase ? { die1: mPhase.die1, die2: mPhase.die2 } : rolledDice;
  const myModifiers = gameState.players[myId]?.zones.hand.filter((c) => c.cardType === 'modifier') ?? [];

  // ── Pre-roll: offer to roll (or skip, in play mode) ──────────────────────
  if (!rolled) {
    return (
      <div style={shell}>
        <span style={{ fontSize: 12.5, color: T.text, fontWeight: 600 }}>
          <strong style={{ color: T.gold }}>{heroName}</strong> · {meta} — roll for its ability?
        </span>
        {mode === 'play' ? (
          <>
            <span onClick={() => isMyTurn && startRoll()} style={{ ...goldButton, opacity: isMyTurn ? 1 : 0.5 }}>Roll ability</span>
            <span onClick={() => isMyTurn && onSkipPlay()} style={{ ...ghostButton, opacity: isMyTurn ? 1 : 0.5 }}>Don't roll</span>
          </>
        ) : (
          <span
            onClick={() => isMyTurn && !hero.effectUsedThisTurn && startRoll()}
            style={{ ...goldButton, opacity: isMyTurn && !hero.effectUsedThisTurn ? 1 : 0.5 }}
          >
            {hero.effectUsedThisTurn ? 'Used this turn' : 'Roll ability'}
          </span>
        )}
        <span onClick={onClose} style={ghostButton}>Close</span>
      </div>
    );
  }

  // ── Post-roll: dice + result / modifier window / activate ────────────────
  const total = mPhase ? mPhase.currentTotal : undefined;
  const need = mPhase ? mPhase.requiredRoll : (template?.rollToPlay ?? undefined);
  const succeeding = mPhase
    ? (mPhase.slayOnLow ? mPhase.currentTotal <= mPhase.requiredRoll : mPhase.currentTotal >= mPhase.requiredRoll)
    : undefined;

  return (
    <div style={shell}>
      <span style={{ ...dieStyle, animation: 'gt-dicePop 0.4s ease' }}>{dice ? dice.die1 : '·'}</span>
      <span style={{ ...dieStyle, animation: 'gt-dicePop 0.45s ease' }}>{dice ? dice.die2 : '·'}</span>

      <span style={{ fontSize: 12.5, color: T.text2 }}>
        rolling for <strong style={{ color: T.gold }}>{heroName}</strong>
        {total != null && <> — <strong style={{ color: '#fff' }}>{total}</strong></>}
        {need != null && <> / needs {need}+</>}
        {isHeroRolling ? (
          <> · <strong style={{ color: T.text }}>rolling…</strong></>
        ) : succeeding != null ? (
          <> · <strong style={{ color: succeeding ? T.green : T.red }}>{succeeding ? 'succeeding' : 'failing'}</strong></>
        ) : null}
      </span>

      {/* Chips for modifiers already played on my roll. */}
      {mPhase?.modifiersPlayed.map((m, i) => (
        <span key={i} style={{ fontSize: 10, fontWeight: 700, padding: '3px 9px', borderRadius: 999, background: T.cardBg2, color: m.amount >= 0 ? T.green : T.red }}>
          {m.playerName} {m.amount >= 0 ? '+' : ''}{m.amount}
        </span>
      ))}

      {!isHeroRolling && myModifierTurn && (
        <>
          <ModifierButtons gameState={gameState} modifiers={myModifiers} rollContext={mPhase!.rollContext} onPlay={onPlayModifier} />
          <span onClick={onPassModifier} style={goldButton}>
            {mPhase!.modifiersPlayed.some((m) => m.playerName === (gameState.players[myId]?.username)) ? 'Done' : 'Accept result'}
          </span>
        </>
      )}

      {!isHeroRolling && modifierPhaseActive && !myModifierTurn && (
        <span style={{ fontSize: 11, color: T.muted }}>waiting for other players…</span>
      )}

      {canActivate && (
        <>
          {resultMessage && <span style={{ fontSize: 11, color: T.green }}>{resultMessage}</span>}
          <span onClick={() => { onActivate(hero.instanceId); }} style={goldButton}>Activate ability</span>
        </>
      )}

      {!isHeroRolling && !modifierPhaseActive && !canActivate && (
        <>
          {resultMessage && <span style={{ fontSize: 11, color: T.text2 }}>{resultMessage}</span>}
          <span onClick={onClose} style={ghostButton}>Done</span>
        </>
      )}
    </div>
  );
}
