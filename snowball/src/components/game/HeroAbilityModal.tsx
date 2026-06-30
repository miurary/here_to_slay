import { useState } from 'react';
import type { CardInstance, GameState } from '../../../../shared/types';
import CardArt from '../CardArt';
import DiceRoll from './DiceRoll';

interface HeroAbilityModalProps {
    gameState: GameState;
    hero: CardInstance;
    /** 'play' = a hero just played from hand (offer to roll its ability); 'party' = activate a hero already in the party. */
    mode: 'play' | 'party';
    isMyTurn: boolean;
    isHeroRolling: boolean;
    rolledDie1?: number;
    rolledDie2?: number;
    /** True while this player's roll is awaiting the opponents' modifier phase. */
    modifierPhaseActive: boolean;
    // play mode
    playHeroRollResult: string | null;
    handlePlayHeroRoll: () => void;
    handleSkipPlayHeroRoll: () => void;
    // party mode
    heroRollResult: string | null;
    handleRollHeroAbility: () => void;
    // shared
    pendingHeroAbilityActivationId: string | null;
    handleActivateHeroAbility: (heroInstanceId: string) => void;
    onClose: () => void;
}

const overlayStyle: React.CSSProperties = {
    position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)',
    display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000,
};
const panelStyle: React.CSSProperties = {
    backgroundColor: 'white', padding: '1.5rem', borderRadius: '12px',
    width: 'min(90vw, 480px)', boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
};
const primaryBtn = (enabled: boolean, color = '#007bff'): React.CSSProperties => ({
    padding: '0.75rem 1.25rem', fontSize: '1rem', backgroundColor: enabled ? color : '#ccc',
    color: 'white', border: 'none', borderRadius: '4px', cursor: enabled ? 'pointer' : 'not-allowed',
});

export default function HeroAbilityModal({
    gameState,
    hero,
    mode,
    isMyTurn,
    isHeroRolling,
    rolledDie1,
    rolledDie2,
    modifierPhaseActive,
    playHeroRollResult,
    handlePlayHeroRoll,
    handleSkipPlayHeroRoll,
    heroRollResult,
    handleRollHeroAbility,
    pendingHeroAbilityActivationId,
    handleActivateHeroAbility,
    onClose,
}: HeroAbilityModalProps) {
    const template = gameState.cardTemplates[hero.templateId];
    const heroName = template?.name || 'Hero';
    const result = mode === 'play' ? playHeroRollResult : heroRollResult;

    // Track that a roll has been started for this prompt so we don't show the
    // roll prompt again while the result is being decided (e.g. during the
    // opponents' modifier phase). The parent keys this component by hero+mode, so
    // it remounts (resetting this) whenever the modal opens for a new hero.
    const [rolled, setRolled] = useState(false);

    const startRoll = () => {
        setRolled(true);
        if (mode === 'play') handlePlayHeroRoll();
        else handleRollHeroAbility();
    };

    // The roll is only fully resolved once the dice animation is done AND there is
    // no modifier phase still in progress for this roll.
    const resolving = isHeroRolling || modifierPhaseActive;
    const canActivate = rolled && !resolving && pendingHeroAbilityActivationId === hero.instanceId;

    return (
        <div style={overlayStyle} onClick={onClose}>
            <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '0.5rem' }}>
                    <button type="button" onClick={onClose} className="primaryButton">Close</button>
                </div>
                <CardArt cardId={hero.templateId} name={heroName} style={{ width: 'min(70vw, 280px)', margin: '0 auto 0.75rem' }} />

                {!rolled ? (
                    mode === 'play' ? (
                        <>
                            <div style={{ marginBottom: '0.75rem' }}>
                                Would you like to roll for this hero's ability before playing it?
                            </div>
                            <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                                <button type="button" onClick={(e) => { e.stopPropagation(); if (isMyTurn) startRoll(); }} disabled={!isMyTurn} style={primaryBtn(isMyTurn)}>
                                    Roll Ability
                                </button>
                                <button type="button" onClick={(e) => { e.stopPropagation(); if (isMyTurn) handleSkipPlayHeroRoll(); }} disabled={!isMyTurn} style={primaryBtn(isMyTurn, '#6c757d')}>
                                    Don't Roll
                                </button>
                            </div>
                        </>
                    ) : (
                        <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); if (isMyTurn && !hero.effectUsedThisTurn) startRoll(); }}
                            disabled={!isMyTurn || hero.effectUsedThisTurn}
                            style={primaryBtn(isMyTurn && !hero.effectUsedThisTurn)}
                        >
                            {hero.effectUsedThisTurn ? 'Ability Used This Turn' : 'Roll for Hero Ability'}
                        </button>
                    )
                ) : (
                    <>
                        <DiceRoll rolling={isHeroRolling} die1={rolledDie1} die2={rolledDie2} />
                        {isHeroRolling ? null : modifierPhaseActive ? (
                            <div style={{ marginTop: '0.5rem', color: '#475569' }}>
                                Waiting for other players to react to your roll…
                            </div>
                        ) : (
                            <>
                                {result && <div style={{ marginTop: '0.5rem', color: '#333' }}>{result}</div>}
                                {canActivate ? (
                                    <button
                                        type="button"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            if (!isMyTurn) return;
                                            handleActivateHeroAbility(hero.instanceId);
                                            // Dismiss so any follow-up ability-options prompt is unobstructed.
                                            onClose();
                                        }}
                                        disabled={!isMyTurn}
                                        style={{ marginTop: '0.75rem', ...primaryBtn(isMyTurn, '#28a745') }}
                                    >
                                        Activate Ability
                                    </button>
                                ) : (
                                    <button type="button" onClick={(e) => { e.stopPropagation(); onClose(); }} style={{ marginTop: '0.75rem', ...primaryBtn(true, '#6c757d') }}>
                                        Done
                                    </button>
                                )}
                            </>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}
