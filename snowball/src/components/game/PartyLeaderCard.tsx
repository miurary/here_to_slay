import type { Dispatch, SetStateAction } from 'react';
import type { GameState } from '../../../../shared/types';
import CardArt from '../CardArt';
import PartyLeaderModal from './PartyLeaderModal';

interface PartyLeaderCardProps {
    gameState: GameState;
    myId: string;
    isMyTurn: boolean;
    onUsePartyLeaderAbility: () => void;
    actionMessage: string | null;
    setActionMessage: Dispatch<SetStateAction<string | null>>;
    modalOpen: boolean;
    setModalOpen: Dispatch<SetStateAction<boolean>>;
    abilityPromptActive: boolean;
}

export default function PartyLeaderCard({ gameState, myId, isMyTurn, onUsePartyLeaderAbility, actionMessage, setActionMessage, modalOpen, setModalOpen, abilityPromptActive }: PartyLeaderCardProps) {
    const player = gameState.players[myId];
    const partyLeaderCard = player?.zones.party.find(c => c.cardType === 'party_leader');
    if (!partyLeaderCard) return null;

    const template = gameState.cardTemplates[partyLeaderCard.templateId];
    const cardName = template?.name || partyLeaderCard.templateId;

    return (
        <div style={{ width: '100%', boxSizing: 'border-box', padding: '1rem', border: '2px solid #333', borderRadius: '8px', backgroundColor: '#faf7f0', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <h3 style={{ marginTop: 0, marginBottom: '0.5rem' }}>Your Party Leader</h3>
            {/* Clickable art scales to the remaining height so the column never scrolls. */}
            <div
                onClick={() => { setActionMessage(null); setModalOpen(true); }}
                title="View party leader"
                style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
            >
                <CardArt cardId={partyLeaderCard.templateId} name={cardName} fit />
            </div>
            {modalOpen && (
                <PartyLeaderModal
                    gameState={gameState}
                    myId={myId}
                    isMyTurn={isMyTurn}
                    onUsePartyLeaderAbility={onUsePartyLeaderAbility}
                    actionMessage={actionMessage}
                    setActionMessage={setActionMessage}
                    abilityPromptActive={abilityPromptActive}
                    onClose={() => { setActionMessage(null); setModalOpen(false); }}
                />
            )}
        </div>
    );
}
