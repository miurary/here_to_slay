import { useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { GameState } from "../../../../shared/types";
import CardArt from "../CardArt";

interface PartyLeaderModalProps {
    gameState: GameState;
    myId: string;
    isMyTurn: boolean;
    onUsePartyLeaderAbility: () => void;
    actionMessage: string | null;
    setActionMessage: Dispatch<SetStateAction<string | null>>;
    abilityPromptActive: boolean;
    onClose: () => void;
}

const overlayStyle: React.CSSProperties = {
    position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)',
    display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000,
};
const panelStyle: React.CSSProperties = {
    backgroundColor: 'white', padding: '1.5rem', borderRadius: '12px',
    width: 'min(92vw, 460px)', maxHeight: '90vh', overflowY: 'auto',
    boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
};

export default function PartyLeaderModal({ gameState, myId, isMyTurn, onUsePartyLeaderAbility, actionMessage, setActionMessage, abilityPromptActive, onClose }: PartyLeaderModalProps) {
    const [attempted, setAttempted] = useState(false);
    const player = gameState.players[myId];
    const partyLeaderCard = player?.zones.party.find(c => c.cardType === 'party_leader');

    const template = partyLeaderCard ? gameState.cardTemplates[partyLeaderCard.templateId] : undefined;
    const isOptional = template?.effect?.isOptional === true;
    const alreadyUsed = partyLeaderCard?.effectUsedThisTurn ?? false;
    const canUse = isMyTurn && isOptional && !alreadyUsed;

    // After a use: dismiss so the result is unobstructed — either the ability
    // resolved instantly (effectUsedThisTurn flips) or it opened a target prompt
    // (abilityPromptActive). A failure leaves both false and surfaces actionMessage here.
    useEffect(() => {
        if (attempted && (alreadyUsed || abilityPromptActive)) onClose();
    }, [attempted, alreadyUsed, abilityPromptActive, onClose]);

    if (!partyLeaderCard) return null;
    const cardName = template?.name || partyLeaderCard.templateId;

    return (
        <div style={overlayStyle} onClick={onClose}>
            <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '0.5rem' }}>
                    <button type="button" onClick={onClose} className="primaryButton">Close</button>
                </div>

                <CardArt cardId={partyLeaderCard.templateId} name={cardName} style={{ width: 'min(72vw, 300px)', margin: '0 auto 1rem' }} />

                {isOptional && (
                    <button
                        type="button"
                        disabled={!canUse}
                        onClick={() => { setActionMessage(null); setAttempted(true); onUsePartyLeaderAbility(); }}
                        style={{
                            display: 'block',
                            width: '100%',
                            padding: '0.6rem 1rem',
                            borderRadius: '6px',
                            border: 'none',
                            backgroundColor: canUse ? '#8e44ad' : '#ccc',
                            color: 'white',
                            cursor: canUse ? 'pointer' : 'not-allowed',
                            fontWeight: 'bold',
                            fontSize: '0.95rem',
                        }}
                    >
                        {alreadyUsed ? 'Ability Used This Turn' : 'Use Ability'}
                    </button>
                )}
                {actionMessage && (
                    <div style={{ marginTop: '0.75rem', padding: '0.5rem 0.75rem', borderRadius: '6px', backgroundColor: '#f8d7da', border: '1px solid #f5c2c7', color: '#842029', fontSize: '0.9rem', textAlign: 'center' }}>
                        {actionMessage}
                    </div>
                )}
            </div>
        </div>
    );
}
