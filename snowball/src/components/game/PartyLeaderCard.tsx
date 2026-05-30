import type { GameState } from '../../../../shared/types';
import { getCardTypeLabel } from '../../utils/gameUtils';

interface PartyLeaderReviewCardProps {
    gameState: GameState;
    myId: string;
}

export default function PartyLeaderCard({ gameState, myId }: PartyLeaderReviewCardProps) {
    return (
        <>
            {gameState.players[myId].zones.party[0] && (() => {
                const partyLeader = gameState.players[myId].zones.party[0];
                const template = gameState.cardTemplates[partyLeader.templateId];
                const cardName = template?.name || partyLeader.templateId;
                const abilityText = (template?.abilityText as string) || '';
                return (
                    <div style={{ width: '220px', padding: '1rem', border: '2px solid #333', borderRadius: '8px', backgroundColor: '#faf7f0' }}>
                    <h3 style={{ marginTop: 0 }}>Your Party Leader</h3>
                    <div style={{ fontSize: '1rem', fontWeight: 'bold', marginBottom: '0.5rem' }}>{cardName}</div>
                    <div style={{ fontSize: '0.8rem', color: '#666', marginBottom: '0.75rem' }}>{getCardTypeLabel(partyLeader, template)}</div>
                    {abilityText && (
                        <div style={{ fontSize: '0.8rem', color: '#333', lineHeight: '1.4' }}>{abilityText}</div>
                    )}
                    </div>
                );
            })()}
        </>
    );
}