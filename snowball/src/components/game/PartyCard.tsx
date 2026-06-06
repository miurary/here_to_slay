import type { GameState } from '../../../../shared/types';
import { getTemplateForInstanceId } from '../../utils/gameUtils';

interface PartyCardProps {
    gameState: GameState;
    myId: string;
    selectedHeroId: string | null;
    setSelectedHeroId: (id: string | null) => void;
    viewedItemId: string | null;
    setViewedItemId: (id: string | null) => void;
    setSelectedHeroLocation: (location: 'party' | 'hand') => void;
    setHeroRollResult: (result: string | null) => void;
    isMyTurn: boolean;
}

export default function PartyCard({ 
    gameState, 
    myId, 
    selectedHeroId, 
    setSelectedHeroId, 
    viewedItemId, 
    setViewedItemId, 
    setSelectedHeroLocation, 
    setHeroRollResult,
    isMyTurn,
}: PartyCardProps) {
    return (
        <div className="panel panelParty">
            <h3 style={{ marginTop: 0 }}>Your Party</h3>
            <div style={{ minHeight: '120px', display: 'grid', gap: '0.75rem' }}>
                {gameState.players[myId].zones.party.filter((card) => card.cardType === 'hero').length > 0 ? (
                gameState.players[myId].zones.party
                    .filter((card) => card.cardType === 'hero')
                    .map((card) => {
                    const template = gameState.cardTemplates[card.templateId];
                    const rollToPlay = template?.rollToPlay as number | undefined;
                    const equippedTemplate = getTemplateForInstanceId(gameState, card.equippedItem);
                    return (
                        <div
                        key={card.instanceId}
                        onClick={(event) => {
                            event.stopPropagation();
                            if (!isMyTurn) return;
                            setSelectedHeroId(card.instanceId);
                            setSelectedHeroLocation('party');
                            setHeroRollResult(null);
                        }}
                        className={`card ${selectedHeroId === card.instanceId ? 'cardSelected' : ''} ${card.cardType === 'hero' ? 'cardHero' : ''}`}
                        style={{ padding: '0.75rem', border: '1px solid #333', borderRadius: '6px', backgroundColor: '#f7f7ff', cursor: isMyTurn ? 'pointer' : 'not-allowed' }}
                        >
                        <div style={{ fontWeight: 'bold', marginBottom: '0.25rem' }}>{template?.name || card.templateId}</div>
                        <div style={{ fontSize: '0.8rem', color: '#666' }}>{template?.class || 'Hero'}</div>
                        {rollToPlay !== undefined && (
                            <div style={{ fontSize: '0.75rem', color: '#444', marginTop: '0.5rem' }}>
                            Roll to use: +{rollToPlay}
                            </div>
                        )}
                        {card.equippedItem && (
                            <div style={{ marginTop: '0.5rem' }}>
                            <div style={{ fontSize: '0.75rem', color: '#333' }}>
                                Equipped: <button type="button" onClick={(e) => { e.stopPropagation(); if (!isMyTurn) return; setViewedItemId(card.equippedItem ?? null); }} style={{ background: 'none', border: 'none', color: isMyTurn ? '#007bff' : '#666', cursor: isMyTurn ? 'pointer' : 'not-allowed', padding: 0 }}>{equippedTemplate?.name || 'Item'}</button>
                            </div>
                            {viewedItemId === card.equippedItem && equippedTemplate && (
                                <div style={{ marginTop: '0.5rem', padding: '0.5rem', backgroundColor: '#fff', border: '1px solid #ddd', borderRadius: '6px' }}>
                                <div style={{ fontWeight: 'bold' }}>{equippedTemplate.name}</div>
                                <div style={{ fontSize: '0.85rem', color: '#666' }}>{(equippedTemplate as any).type || ''}</div>
                                <div style={{ marginTop: '0.5rem', fontSize: '0.85rem', color: '#333' }}>{((equippedTemplate as any).abilityText as string) || ''}</div>
                                <div style={{ marginTop: '0.5rem' }}>
                                    <button type="button" onClick={() => setViewedItemId(null)} style={{ padding: '0.25rem 0.5rem', backgroundColor: '#6c757d', color: 'white', border: 'none', borderRadius: '4px' }}>Close</button>
                                </div>
                                </div>
                            )}
                            </div>
                        )}
                        </div>
                    );
                    })
                ) : (
                <div style={{ color: '#666' }}>Play hero cards from your hand to your party.</div>
                )}
            </div>
        </div>
    );
}
