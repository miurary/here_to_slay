import type { GameState } from '../../../../shared/types';

interface RollCompleteCardProps {
    gameState: GameState;
    myId: string;
    handleContinue: () => void;
    /** Seconds until the server auto-advances, or null when no countdown is pending. */
    autoAdvanceSeconds?: number | null;
}

export default function RollCompleteCard( { gameState, myId, handleContinue, autoAdvanceSeconds }: RollCompleteCardProps) {
    return (
        <div className="panel panelAccentGreen">
            <h2>Roll Results</h2>
            <p style={{ fontSize: '1rem', marginBottom: '1rem' }}>
            {gameState.rollWinnerId
                ? `${gameState.players[gameState.rollWinnerId]?.username || 'A player'} won and will go first!`
                : 'All players have rolled. See results below.'}
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '0.75rem', marginBottom: '1rem' }}>
            {Object.entries(gameState.diceRolls).map(([playerId, roll]) => {
                const player = gameState.players[playerId];
                return (
                <div key={playerId} style={{ padding: '0.75rem', backgroundColor: 'oklch(0.24 0.015 260)', borderRadius: '8px', border: '1px solid oklch(0.34 0.015 260)' }}>
                    <div style={{ fontWeight: 'bold' }}>{player.username || 'Player'}</div>
                    <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'oklch(0.75 0.11 150)' }}>{roll}</div>
                </div>
                );
            })}
            </div>
            {autoAdvanceSeconds != null && (
            <p style={{ fontWeight: 700, color: 'oklch(0.75 0.11 150)', marginBottom: '0.75rem' }}>
                Continuing in {autoAdvanceSeconds}…
            </p>
            )}
            {gameState.lobbyLeaderId === myId ? (
            <button type="button" onClick={handleContinue} className="buttonPrimary" style={{ fontSize: '1.05rem' }}>
                {autoAdvanceSeconds != null ? 'Continue now' : 'Continue to Game'}
            </button>
            ) : autoAdvanceSeconds == null && (
            <p style={{ color: '#9aa0ad' }}>
                Waiting for {gameState.lobbyLeaderId ? gameState.players[gameState.lobbyLeaderId]?.username : 'the lobby leader'} to continue to the game...
            </p>
            )}
        </div>
    )
}