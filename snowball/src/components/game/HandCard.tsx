import type { CardInstance, GameState } from '../../../../shared/types';
import type { Dispatch, SetStateAction } from 'react';
import CardArt from '../CardArt';

interface HandCardProps {
    gameState: GameState;
    myId: string;
    selectedHeroId: string | null;
    setSelectedHeroId: Dispatch<SetStateAction<string | null>>;
    setViewedItemId: Dispatch<SetStateAction<string | null>>;
    setSelectedHeroLocation: Dispatch<SetStateAction<'hand' | 'party' | null>>;
    setHeroRollResult: Dispatch<SetStateAction<string | null>>;
    handlePlayHero: (instanceId: string) => void;
    handlePlayMagic: (instanceId: string) => void;
    handleInitiateCursedItemPlay: (instanceId: string) => void;
    setPendingItemPlayId: Dispatch<SetStateAction<string | null>>;
    setItemPlayPromptOpen: Dispatch<SetStateAction<boolean>>;
    pendingHeroPlayId: string | null;
    selectedHero: CardInstance | undefined;
    selectedHeroLocation: 'party' | 'hand' | null;
    playHeroPromptOpen: boolean;
    selectedHeroAP: number;
    isMyTurn: boolean;
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
    handlePlayMagic,
    handleInitiateCursedItemPlay,
    setPendingItemPlayId,
    setItemPlayPromptOpen,
    pendingHeroPlayId,
    selectedHero,
    selectedHeroLocation,
    playHeroPromptOpen,
    selectedHeroAP,
    isMyTurn,
}: HandCardProps) {

    return (
        <div className="panel panelHand">
            <h3>Your Hand ({gameState.players[myId].zones.hand.length} cards)</h3>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                {gameState.players[myId].zones.hand.map((card) => {
                const template = gameState.cardTemplates[card.templateId];
                const cardName = template?.name || card.templateId;
                const isCursed = (template?.subtype as string | undefined)?.toLowerCase() === 'cursed';
                return (
                    <div
                    key={card.instanceId}
                    onClick={(event) => {
                        event.stopPropagation();
                        if (!isMyTurn) return;
                        if (card.cardType === 'hero') {
                          setSelectedHeroId(card.instanceId);
                          setSelectedHeroLocation('hand');
                          setHeroRollResult(null);
                        }
                        if (card.cardType === 'item') {
                          if (isCursed) {
                            handleInitiateCursedItemPlay(card.instanceId);
                          } else {
                            setPendingItemPlayId(card.instanceId);
                            setItemPlayPromptOpen(true);
                            setViewedItemId(null);
                          }
                        }
                    }}
                    className={`card ${selectedHeroId === card.instanceId ? 'cardSelected' : ''} ${card.cardType === 'hero' ? 'cardHero' : ''}`}
                    >
                    <CardArt cardId={card.templateId} name={cardName} />
                    {card.cardType === 'item' && (
                        <button
                        type="button"
                        onClick={(event) => {
                            event.stopPropagation();
                            if (!isMyTurn) return;
                            if (isCursed) {
                              handleInitiateCursedItemPlay(card.instanceId);
                            } else {
                              setPendingItemPlayId(card.instanceId);
                              setItemPlayPromptOpen(true);
                              setViewedItemId(null);
                            }
                        }}
                        disabled={!isMyTurn}
                        style={{ marginTop: '0.4rem', padding: '0.4rem 0.6rem', fontSize: '0.8rem', backgroundColor: !isMyTurn ? '#999' : '#007bff', color: 'white', border: 'none', borderRadius: '6px', cursor: !isMyTurn ? 'not-allowed' : 'pointer', width: '100%' }}
                        >
                        Use Item
                        </button>
                    )}
                    {card.cardType === 'magic' && (
                        <button
                        type="button"
                        onClick={(event) => {
                            event.stopPropagation();
                            if (!isMyTurn) return;
                            handlePlayMagic(card.instanceId);
                        }}
                        disabled={!isMyTurn}
                        style={{ marginTop: '0.4rem', padding: '0.4rem 0.6rem', fontSize: '0.8rem', backgroundColor: !isMyTurn ? '#999' : '#8e44ad', color: 'white', border: 'none', borderRadius: '6px', cursor: !isMyTurn ? 'not-allowed' : 'pointer', width: '100%' }}
                        >
                        Play Magic
                        </button>
                    )}
                    </div>
                );
                })}
            </div>

            {/* Selecting a hero in your hand offers to play it. The roll/activate
                ability prompt now lives in its own modal (HeroAbilityModal), opened
                once the hero is played or when a party hero is selected. */}
            {selectedHero && selectedHeroLocation === 'hand' && (
                <div style={{ marginTop: '1rem', padding: '1rem', border: '1px solid #007bff', borderRadius: '8px', backgroundColor: '#e7f3ff' }}>
                <button
                    type="button"
                    onClick={(event) => {
                    event.stopPropagation();
                    if (!isMyTurn) return;
                    handlePlayHero(selectedHero.instanceId);
                    }}
                    disabled={!isMyTurn || selectedHeroAP < 1 || (playHeroPromptOpen && pendingHeroPlayId === selectedHero.instanceId)}
                    style={{
                    padding: '0.75rem 1.25rem',
                    fontSize: '1rem',
                    backgroundColor: !isMyTurn || selectedHeroAP < 1 || (playHeroPromptOpen && pendingHeroPlayId === selectedHero.instanceId) ? '#ccc' : '#007bff',
                    color: 'white',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: !isMyTurn || selectedHeroAP < 1 || (playHeroPromptOpen && pendingHeroPlayId === selectedHero.instanceId) ? 'not-allowed' : 'pointer',
                    }}
                >
                    {playHeroPromptOpen && pendingHeroPlayId === selectedHero.instanceId ? 'Waiting for roll decision…' : 'Play Hero (-1 AP)'}
                </button>
                {selectedHeroAP < 1 && (
                    <div style={{ marginTop: '0.75rem', color: '#c00' }}>
                    You need at least 1 AP to play this hero.
                    </div>
                )}
                </div>
            )}
        </div>
    );
}