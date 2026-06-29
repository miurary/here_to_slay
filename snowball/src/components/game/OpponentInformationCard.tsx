import type { GameState } from "../../../../shared/types";
import { getTemplateForInstanceId } from "../../utils/gameUtils";
import CardArt from "../CardArt";
import type { Dispatch, SetStateAction } from 'react';

interface OpponentInformationCardProps {
    gameState: GameState;
    myId: string;
    selectedOpponentPartyId: string | null;
    viewedItemId: string | null;
    setSelectedOpponentPartyId: Dispatch<SetStateAction<string | null>>;
    setViewedItemId: Dispatch<SetStateAction<string | null>>;
}

export default function OpponentInformationCard({ gameState, myId, selectedOpponentPartyId, viewedItemId, setSelectedOpponentPartyId, setViewedItemId }: OpponentInformationCardProps) {
    return (
        <div style={{ padding: '1rem', border: '1px solid #bbb', borderRadius: '8px', backgroundColor: 'white' }}>
            <h3>Opponents' Party Leaders</h3>
            <div style={{ display: 'grid', gap: '0.75rem' }}>
            {Object.values(gameState.players)
                .filter((player) => player.id !== myId)
                .map((player) => {
                const chosen = player.zones.party[0];
                const template = chosen ? gameState.cardTemplates[chosen.templateId] : undefined;
                return (
                    <div key={player.id} style={{ padding: '0.75rem', border: '1px solid #ddd', borderRadius: '8px', backgroundColor: '#fafafa' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.75rem' }}>
                        <div>
                        <div style={{ fontWeight: 'bold', marginBottom: '0.25rem' }}>{player.username || 'Player'}</div>
                        {chosen ? (
                            <>
                            <CardArt cardId={chosen.templateId} name={template?.name} style={{ margin: '0.25rem 0' }} />
                            </>
                        ) : (
                            <div style={{ color: '#999' }}>No leader chosen</div>
                        )}
                        </div>
                        <button
                        type="button"
                        onClick={() => setSelectedOpponentPartyId((current) => current === player.id ? null : player.id)}
                        style={{ padding: '0.5rem 0.75rem', backgroundColor: selectedOpponentPartyId === player.id ? '#6c757d' : '#007bff', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
                        >
                        {selectedOpponentPartyId === player.id ? 'Hide Party' : 'View Party'}
                        </button>
                    </div>
                    <div style={{ marginTop: '0.75rem', fontSize: '0.85rem', color: '#333' }}>
                        Hand size: {player.zones.hand.length}
                    </div>
                    </div>
                );
                })}
            </div>
            {selectedOpponentPartyId && gameState.players[selectedOpponentPartyId] && (
            <div style={{ marginTop: '1rem', padding: '1rem', border: '1px solid #007bff', borderRadius: '8px', backgroundColor: '#eef5ff' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', marginBottom: '0.75rem' }}>
                <div>
                    <div style={{ fontWeight: 'bold', fontSize: '1rem' }}>{gameState.players[selectedOpponentPartyId].username || 'Player'}'s Party</div>
                    <div style={{ fontSize: '0.85rem', color: '#555' }}>Party size: {gameState.players[selectedOpponentPartyId].zones.party.length}</div>
                </div>
                <button
                    type="button"
                    onClick={() => setSelectedOpponentPartyId(null)}
                    style={{ padding: '0.5rem 0.75rem', backgroundColor: '#6c757d', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
                >
                    Close
                </button>
                </div>
                <div style={{ display: 'grid', gap: '0.75rem' }}>
                {gameState.players[selectedOpponentPartyId].zones.party.length > 0 ? (
                    gameState.players[selectedOpponentPartyId].zones.party.map((card) => {
                    const template = gameState.cardTemplates[card.templateId];
                    const equippedTemplate = getTemplateForInstanceId(gameState, card.equippedItem);
                    return (
                        <div key={card.instanceId} style={{ padding: '0.75rem', border: '1px solid #ddd', borderRadius: '8px', backgroundColor: 'white' }}>
                        <CardArt cardId={card.templateId} name={template?.name} style={{ margin: '0 auto 0.4rem' }} />
                        {card.equippedItem && (
                            <div style={{ marginTop: '0.5rem' }}>
                            <div style={{ fontSize: '0.85rem', color: '#333' }}>
                                Equipped: <button type="button" onClick={() => setViewedItemId(card.equippedItem ?? null)} style={{ background: 'none', border: 'none', color: '#007bff', cursor: 'pointer', padding: 0 }}>{equippedTemplate?.name || 'Item'}</button>
                            </div>
                            {viewedItemId === card.equippedItem && equippedTemplate && (
                                <div style={{ marginTop: '0.5rem', padding: '0.5rem', backgroundColor: '#fff', border: '1px solid #ddd', borderRadius: '6px' }}>
                                <div style={{ fontWeight: 'bold' }}>{equippedTemplate.name}</div>
                                <div style={{ fontSize: '0.85rem', color: '#666' }}>{equippedTemplate.type}</div>
                                <div style={{ marginTop: '0.5rem', fontSize: '0.85rem', color: '#333' }}>{equippedTemplate.abilityText ?? ''}</div>
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
                    <div style={{ color: '#666' }}>No party cards to display.</div>
                )}
                </div>
            </div>
            )}
        </div>
    )
}