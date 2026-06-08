import type { GameState } from '../../../../shared/types';
import { getCardTypeLabel } from '../../utils/gameUtils';

interface PartyLeaderCardProps {
    gameState: GameState;
    myId: string;
    isMyTurn: boolean;
    onUsePartyLeaderAbility: () => void;
}

export default function PartyLeaderCard({ gameState, myId, isMyTurn, onUsePartyLeaderAbility }: PartyLeaderCardProps) {
    const player = gameState.players[myId];
    const partyLeaderCard = player?.zones.party.find(c => c.cardType === 'party_leader');
    if (!partyLeaderCard) return null;

    const template = gameState.cardTemplates[partyLeaderCard.templateId] as any;
    const cardName = template?.name || partyLeaderCard.templateId;
    const abilityText = (template?.abilityText as string) || '';
    const isOptional = template?.effect?.isOptional === true;
    const alreadyUsed = partyLeaderCard.effectUsedThisTurn;
    const canUse = isMyTurn && isOptional && !alreadyUsed;

    return (
        <div style={{ width: '220px', padding: '1rem', border: '2px solid #333', borderRadius: '8px', backgroundColor: '#faf7f0' }}>
            <h3 style={{ marginTop: 0 }}>Your Party Leader</h3>
            <div style={{ fontSize: '1rem', fontWeight: 'bold', marginBottom: '0.5rem' }}>{cardName}</div>
            <div style={{ fontSize: '0.8rem', color: '#666', marginBottom: '0.75rem' }}>{getCardTypeLabel(partyLeaderCard, template)}</div>
            {abilityText && (
                <div style={{ fontSize: '0.8rem', color: '#333', lineHeight: '1.4', marginBottom: '0.75rem' }}>{abilityText}</div>
            )}
            {isOptional ? (
                <>
                    <div style={{
                        display: 'inline-block',
                        padding: '0.2rem 0.5rem',
                        borderRadius: '4px',
                        fontSize: '0.7rem',
                        fontWeight: 'bold',
                        backgroundColor: alreadyUsed ? '#eee' : '#fff3cd',
                        color: alreadyUsed ? '#999' : '#856404',
                        border: `1px solid ${alreadyUsed ? '#ccc' : '#ffc107'}`,
                        marginBottom: '0.6rem',
                    }}>
                        {alreadyUsed ? 'Used this turn' : 'Once per turn'}
                    </div>
                    <button
                        type="button"
                        disabled={!canUse}
                        onClick={onUsePartyLeaderAbility}
                        style={{
                            display: 'block',
                            width: '100%',
                            padding: '0.5rem 0.75rem',
                            borderRadius: '6px',
                            border: 'none',
                            backgroundColor: canUse ? '#8e44ad' : '#ccc',
                            color: 'white',
                            cursor: canUse ? 'pointer' : 'not-allowed',
                            fontWeight: 'bold',
                            fontSize: '0.85rem',
                        }}
                    >
                        Use Ability
                    </button>
                    {!isMyTurn && !alreadyUsed && (
                        <div style={{ fontSize: '0.75rem', color: '#888', marginTop: '0.4rem' }}>Only on your turn.</div>
                    )}
                </>
            ) : (
                <div style={{
                    display: 'inline-block',
                    padding: '0.2rem 0.5rem',
                    borderRadius: '4px',
                    fontSize: '0.7rem',
                    fontWeight: 'bold',
                    backgroundColor: '#e8f4fd',
                    color: '#0c5460',
                    border: '1px solid #bee5eb',
                }}>
                    Passive — triggers automatically
                </div>
            )}
        </div>
    );
}
