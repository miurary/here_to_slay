import type { GameState } from '../../../../shared/types';

interface UsernameCardProps {
    gameState: GameState;
    myId: string;
    handleChoosePartyLeader: (instanceId: string) => void;
}

export default function PartyLeaderSelectionCard({ gameState, myId, handleChoosePartyLeader }: UsernameCardProps) {
  return (
    <div className="panel panelAccentPurple">
        <h2>Select Your Party Leader</h2>
        <p style={{ marginBottom: '1rem' }}>
            Current chooser: {gameState.currentSelectionPlayerId ? gameState.players[gameState.currentSelectionPlayerId]?.username || 'Player' : 'None'}
        </p>
        <p style={{ marginBottom: '1rem', color: '#333' }}>
            {gameState.currentSelectionPlayerId === myId
            ? 'It is your turn to choose a party leader from the face down cards below.'
            : 'Waiting for the current player to choose a party leader.'}
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '0.75rem', marginBottom: '1rem' }}>
            {gameState.availablePartyLeaderCards.map((card) => (
            <button
                key={card.instanceId}
                type="button"
                onClick={() => handleChoosePartyLeader(card.instanceId)}
                disabled={gameState.currentSelectionPlayerId !== myId}
                style={{
                height: '150px',
                backgroundColor: '#4a148c',
                color: 'white',
                borderRadius: '8px',
                border: '2px solid #2e0a4d',
                cursor: gameState.currentSelectionPlayerId === myId ? 'pointer' : 'not-allowed',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                alignItems: 'center',
                }}
            >
                <div style={{ fontSize: '1rem', fontWeight: 'bold' }}>Party Leader</div>
                <div style={{ marginTop: '0.5rem', opacity: 0.85 }}>Face Down</div>
            </button>
            ))}
        </div>
        <div>
            <h4>Chosen Party Leaders</h4>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '0.75rem' }}>
            {Object.values(gameState.players).map((player) => {
                const chosen = player.zones.party[0];
                const template = chosen ? gameState.cardTemplates[chosen.templateId] : undefined;
                return (
                <div key={player.id} style={{ padding: '0.75rem', backgroundColor: 'white', borderRadius: '4px', border: '1px solid #ddd' }}>
                    <div style={{ fontWeight: 'bold', marginBottom: '0.25rem' }}>{player.username || 'Player'}</div>
                    {chosen ? (
                    <>
                        <div style={{ fontSize: '0.9rem' }}>{template?.name || chosen.templateId}</div>
                        <div style={{ fontSize: '0.75rem', color: '#666' }}>{(template?.abilityText as string) || ''}</div>
                    </>
                    ) : (
                    <div style={{ color: '#999' }}>Not chosen yet</div>
                    )}
                </div>
                );
            })}
            </div>
        </div>
    </div>
  );
}