import type { GameState } from '../../../../shared/types';
import CardArt from '../CardArt';

interface PartyLeaderReviewCardProps {
    gameState: GameState;
    myId: string;
    handleContinue: () => void;
}

export default function PartyLeaderReviewCard({ gameState, myId, handleContinue }: PartyLeaderReviewCardProps) {
    return (
        <div className="panel panelAccentGreen" style={{ width: '100%', boxSizing: 'border-box' }}>
            <h2 style={{ marginBottom: '0.5rem' }}>Party Leader Review</h2>
            <p style={{ fontSize: '0.95rem', marginBottom: '0.75rem' }}>
                All players have chosen their party leaders. Review the choices below before continuing into the game.
            </p>
            <div style={{ display: 'flex', gap: '0.75rem', overflowX: 'auto', paddingBottom: '0.25rem', marginBottom: '1rem' }}>
                {Object.values(gameState.players).map((player) => {
                const chosen = player.zones.party[0];
                const template = chosen ? gameState.cardTemplates[chosen.templateId] : undefined;
                return (
                    <div key={player.id} style={{ flex: '1 1 0', minWidth: '160px', padding: '0.75rem', backgroundColor: 'white', borderRadius: '4px', border: '1px solid #ddd' }}>
                    <div style={{ fontWeight: 'bold', marginBottom: '0.5rem' }}>{player.username || 'Player'}</div>
                    {chosen ? (
                        <>
                        <CardArt cardId={chosen.templateId} name={template?.name} style={{ margin: '0 auto' }} />
                        </>
                    ) : (
                        <div style={{ color: '#999' }}>No party leader chosen</div>
                    )}
                    </div>
                );
                })}
            </div>
            <div style={{ marginBottom: '1rem' }}>
                <h3 style={{ marginBottom: '0.5rem' }}>Revealed Monsters</h3>
                <div style={{ display: 'flex', gap: '0.75rem', overflowX: 'auto', paddingBottom: '0.25rem' }}>
                {gameState.activeMonsters.map((monster) => {
                    const template = gameState.cardTemplates[monster.templateId];
                    return (
                    <div key={monster.instanceId} style={{ padding: '0.5rem', backgroundColor: 'white', borderRadius: '8px', border: '1px solid #ddd' }}>
                        <CardArt cardId={monster.templateId} name={template?.name} style={{ margin: '0 auto' }} />
                    </div>
                    );
                })}
                </div>
            </div>
            {gameState.lobbyLeaderId === myId ? (
                <button type="button" onClick={handleContinue} style={{ padding: '0.75rem 1.5rem', fontSize: '1.1rem', backgroundColor: '#20c997', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>
                Continue to Game
                </button>
            ) : (
                <p style={{ color: '#666' }}>
                Waiting for {gameState.lobbyLeaderId ? gameState.players[gameState.lobbyLeaderId]?.username : 'the lobby leader'} to continue to the game...
                </p>
            )}
        </div>
    );
}