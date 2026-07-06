import type { Dispatch, SetStateAction } from 'react';
import type { GameState } from "../../../../shared/types";
import { getTemplateForInstanceId } from "../../utils/gameUtils";
import { getClassColor } from "../../utils/classColors";
import CardArt from "../CardArt";

interface OpponentPartyModalProps {
    gameState: GameState;
    playerId: string;
    viewedItemId: string | null;
    setViewedItemId: Dispatch<SetStateAction<string | null>>;
    onClose: () => void;
}

const overlayStyle: React.CSSProperties = {
    position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)',
    display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000,
};
const panelStyle: React.CSSProperties = {
    backgroundColor: 'white', padding: '1.5rem', borderRadius: '12px',
    width: 'min(92vw, 560px)', maxHeight: '85vh', overflowY: 'auto',
    boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
};

export default function OpponentPartyModal({ gameState, playerId, viewedItemId, setViewedItemId, onClose }: OpponentPartyModalProps) {
    const player = gameState.players[playerId];
    if (!player) return null;

    const leader = player.zones.party[0];
    const leaderTemplate = leader ? gameState.cardTemplates[leader.templateId] : undefined;
    const heroes = player.zones.party.filter((card) => card.cardType === 'hero');

    return (
        <div style={overlayStyle} onClick={onClose}>
            <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', marginBottom: '1rem' }}>
                    <div>
                        <div style={{ fontWeight: 'bold', fontSize: '1.1rem' }}>{player.username || 'Player'}'s Party</div>
                        <div style={{ fontSize: '0.85rem', color: '#555' }}>Party size: {player.zones.party.length}</div>
                    </div>
                    <button type="button" onClick={onClose} className="primaryButton">Close</button>
                </div>

                <div style={{ marginBottom: '1rem' }}>
                    <div style={{ fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: '#888', marginBottom: '0.4rem' }}>Party Leader</div>
                    {leader ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                            <CardArt cardId={leader.templateId} name={leaderTemplate?.name} />
                            <div>
                                <div style={{ fontWeight: 'bold' }}>{leaderTemplate?.name || 'Leader'}</div>
                                {leaderTemplate?.class && (
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem', color: '#555', textTransform: 'capitalize' }}>
                                        <span style={{ width: 10, height: 10, borderRadius: '50%', backgroundColor: getClassColor(leaderTemplate.class), display: 'inline-block' }} />
                                        {leaderTemplate.class}
                                    </div>
                                )}
                            </div>
                        </div>
                    ) : (
                        <div style={{ color: '#999' }}>No leader chosen</div>
                    )}
                </div>

                <div style={{ fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: '#888', marginBottom: '0.4rem' }}>Heroes</div>
                <div style={{ display: 'grid', gap: '0.75rem' }}>
                    {heroes.length > 0 ? (
                        heroes.map((card) => {
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
                        <div style={{ color: '#666' }}>No heroes in party.</div>
                    )}
                </div>
            </div>
        </div>
    );
}
