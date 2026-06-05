import type { CardInstance, GameState } from '../../../../shared/types';
import { getCardTypeLabel } from '../../utils/gameUtils';
import type { Dispatch, SetStateAction } from 'react';

interface HandCardProps {
    gameState: GameState;
    myId: string;
    selectedHeroId: string | null;
    setSelectedHeroId: Dispatch<SetStateAction<string | null>>;
    setViewedItemId: Dispatch<SetStateAction<string | null>>;
    setSelectedHeroLocation: Dispatch<SetStateAction<'hand' | 'party' | null>>;
    setHeroRollResult: Dispatch<SetStateAction<string | null>>;
    handlePlayHero: (instanceId: string) => void;
    handleInitiateCursedItemPlay: (instanceId: string) => void;
    setPendingItemPlayId: Dispatch<SetStateAction<string | null>>;
    setItemPlayPromptOpen: Dispatch<SetStateAction<boolean>>;
    pendingHeroPlayId: string | null;
    selectedHero: CardInstance | undefined;
    selectedHeroLocation: 'party' | 'hand' | null;
    heroRollResult: string | null;
    playHeroPromptOpen: boolean;
    isHeroRolling: boolean;
    selectedHeroAP: number;
    handlePlayHeroRoll: () => void;
    handleSkipPlayHeroRoll: () => void;
    handleRollHeroAbility: () => void;
    playHeroRollResult: string | null;
}

export default function HandCard({ 
    gameState, 
    myId, 
    selectedHeroId, 
    setSelectedHeroId, 
    setViewedItemId, 
    setSelectedHeroLocation, 
    setHeroRollResult,
    handlePlayHero,
    handleInitiateCursedItemPlay,
    setPendingItemPlayId,
    setItemPlayPromptOpen,
    pendingHeroPlayId,
    selectedHero,
    selectedHeroLocation,
    heroRollResult,
    playHeroPromptOpen,
    isHeroRolling,
    selectedHeroAP,
    handlePlayHeroRoll,
    handleSkipPlayHeroRoll,
    handleRollHeroAbility,
    playHeroRollResult
}: HandCardProps) {
    console.log("Hand card playHeroRollResult: ", playHeroRollResult, "pendingHeroPlayId: ", pendingHeroPlayId);

    return (
        <div className="panel panelHand">
            <h3>Your Hand ({gameState.players[myId].zones.hand.length} cards)</h3>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                {gameState.players[myId].zones.hand.map((card) => {
                const template = gameState.cardTemplates[card.templateId];
                const cardName = template?.name || card.templateId;
                const abilityText = (template?.abilityText as string) || '';
                const rollToPlay = template?.rollToPlay as number | undefined;
                const heroClass = template?.class as string | undefined;
                return (
                    <div
                    key={card.instanceId}
                    onClick={(event) => {
                        event.stopPropagation();
                        if (card.cardType === 'hero') {
                        setSelectedHeroId(card.instanceId);
                        setSelectedHeroLocation('hand');
                        setHeroRollResult(null);
                        }
                        if (card.cardType === 'item') {
                        const isCursed = (template?.subtype as string | undefined)?.toLowerCase() === 'cursed';
                        if (isCursed) {
                            handleInitiateCursedItemPlay(card.instanceId);
                        } else {
                            // start regular item play flow
                            setPendingItemPlayId(card.instanceId);
                            setItemPlayPromptOpen(true);
                            setViewedItemId(null);
                        }
                        }
                    }}
                    className={`card ${selectedHeroId === card.instanceId ? 'cardSelected' : ''} ${card.cardType === 'hero' ? 'cardHero' : ''}`}
                    >
                    <div style={{ fontSize: '0.85rem', fontWeight: 'bold' }}>{cardName}</div>
                    <div style={{ fontSize: '0.7rem', color: '#666', marginTop: '0.25rem' }}>
                        {getCardTypeLabel(card, template)}
                    </div>
                    {card.cardType === 'hero' && (
                        <>
                        {heroClass && (
                            <div style={{ fontSize: '0.75rem', color: '#444', marginTop: '0.5rem' }}>
                            Class: {heroClass}
                            </div>
                        )}
                        {rollToPlay !== undefined && (
                            <div style={{ fontSize: '0.75rem', color: '#444', marginTop: '0.25rem' }}>
                            Roll to play: +{rollToPlay}
                            </div>
                        )}
                        </>
                    )}
                    {card.cardType === 'item' && (
                        <button
                        type="button"
                        onClick={(event) => {
                            event.stopPropagation();
                            const isCursed = (template?.subtype as string | undefined)?.toLowerCase() === 'cursed';
                            if (isCursed) {
                            handleInitiateCursedItemPlay(card.instanceId);
                            } else {
                            setPendingItemPlayId(card.instanceId);
                            setItemPlayPromptOpen(true);
                            setViewedItemId(null);
                            }
                        }}
                        style={{ marginTop: '0.75rem', padding: '0.45rem 0.75rem', fontSize: '0.8rem', backgroundColor: '#007bff', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer' }}
                        >
                        Use Item
                        </button>
                    )}
                    {abilityText && (
                        <div style={{ fontSize: '0.65rem', color: '#333', marginTop: '0.5rem', fontStyle: 'italic', lineHeight: '1.3' }}>
                        {abilityText}
                        </div>
                    )}
                    </div>
                );
                })}
            </div>

            {selectedHero && (
                <div style={{ marginTop: '1rem', padding: '1rem', border: '1px solid #007bff', borderRadius: '8px', backgroundColor: '#e7f3ff' }}>
                <div style={{ marginBottom: '0.75rem' }}>
                    <strong>Selected Hero:</strong> {selectedHero ? gameState.cardTemplates[selectedHero.templateId]?.name || 'Hero' : 'None'}
                </div>
                <div style={{ marginBottom: '0.75rem', color: '#333' }}>
                    {(gameState.cardTemplates[selectedHero.templateId]?.abilityText as string) || 'No ability text available.'}
                </div>
                {selectedHeroLocation === 'hand' ? (
                    <>
                    <button
                        type="button"
                        onClick={(event) => {
                        event.stopPropagation();
                        handlePlayHero(selectedHero.instanceId);
                        }}
                        disabled={selectedHeroAP < 1 || (playHeroPromptOpen && pendingHeroPlayId === selectedHero.instanceId)}
                        style={{
                        padding: '0.75rem 1.25rem',
                        fontSize: '1rem',
                        backgroundColor: selectedHeroAP < 1 || (playHeroPromptOpen && pendingHeroPlayId === selectedHero.instanceId) ? '#ccc' : '#007bff',
                        color: 'white',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: selectedHeroAP < 1 || (playHeroPromptOpen && pendingHeroPlayId === selectedHero.instanceId) ? 'not-allowed' : 'pointer',
                        }}
                    >
                        {playHeroPromptOpen && pendingHeroPlayId === selectedHero.instanceId ? 'Waiting for roll decision…' : 'Play Hero (-1 AP)'}
                    </button>
                    {selectedHeroAP < 1 && (
                        <div style={{ marginTop: '0.75rem', color: '#c00' }}>
                        You need at least 1 AP to play this hero.
                        </div>
                    )}
                    {playHeroPromptOpen && pendingHeroPlayId === selectedHero.instanceId && (
                        <div style={{ marginTop: '1rem', padding: '1rem', border: '1px dashed #007bff', borderRadius: '8px', backgroundColor: '#eef5ff' }}>
                        {!isHeroRolling && (
                            <div style={{ marginBottom: '0.75rem' }}>
                            Would you like to roll for this hero's ability before playing it?
                            </div>
                        )}
                        {!isHeroRolling && (
                            <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                            <button
                                type="button"
                                onClick={(event) => {
                                event.stopPropagation();
                                handlePlayHeroRoll();
                                }}
                                disabled={isHeroRolling}
                                style={{ padding: '0.75rem 1.25rem', fontSize: '1rem', backgroundColor: isHeroRolling ? '#ccc' : '#007bff', color: 'white', border: 'none', borderRadius: '4px', cursor: isHeroRolling ? 'not-allowed' : 'pointer' }}
                            >
                                Roll Ability
                            </button>
                            <button
                                type="button"
                                onClick={(event) => {
                                event.stopPropagation();
                                handleSkipPlayHeroRoll();
                                }}
                                disabled={isHeroRolling}
                                style={{ padding: '0.75rem 1.25rem', fontSize: '1rem', backgroundColor: isHeroRolling ? '#ccc' : '#6c757d', color: 'white', border: 'none', borderRadius: '4px', cursor: isHeroRolling ? 'not-allowed' : 'pointer' }}
                            >
                                Don't Roll
                            </button>
                            </div>
                        )}
                        {isHeroRolling && (
                            <div style={{ fontSize: '2rem', marginTop: '1rem', animation: 'spin 0.1s infinite' }}>
                            🎲 🎲
                            </div>
                        )}
                        {playHeroRollResult && (
                            <div style={{ marginTop: '0.75rem', color: '#333' }}>
                            {playHeroRollResult}
                            </div>
                        )}
                        </div>
                    )}
                    </>
                ) : selectedHeroLocation === 'party' ? (
                    <>
                    <button
                        type="button"
                        onClick={(event) => {
                        event.stopPropagation();
                        handleRollHeroAbility();
                        }}
                        style={{
                        padding: '0.75rem 1.25rem',
                        fontSize: '1rem',
                        backgroundColor: '#007bff',
                        color: 'white',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        }}
                    >
                        Roll for Hero Ability
                    </button>
                    {heroRollResult && (
                        <div style={{ marginTop: '0.75rem', color: '#333' }}>
                        {heroRollResult}
                        </div>
                    )}
                    </>
                ) : null}
                </div>
            )}
        </div>
    );
}