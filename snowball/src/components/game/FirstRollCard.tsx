import type { GameState } from '../../../../shared/types';

interface FirstRollCardProps {
    gameState: GameState;
    myId: string;
    handleRoll: () => void;
    isRolling: boolean;
    myRoll: number | null;
}

export default function FirstRollCard({ gameState, myId, handleRoll, isRolling, myRoll }: FirstRollCardProps) {
    return (
        <div className="panel panelAccentBlue">
            <h2>Roll for First Player!</h2>
            <p>Roll two 6-sided dice - highest sum goes first!</p>
            {gameState.currentRollerId && (
                <div style={{ marginBottom: '1.5rem', padding: '1rem', backgroundColor: 'white', borderRadius: '4px', border: '2px solid #ff9800' }}>
                <strong style={{ color: '#ff9800', fontSize: '1.1rem' }}>
                    Currently rolling: {gameState.currentRollerId ? gameState.players[gameState.currentRollerId]?.username || gameState.currentRollerId : 'Unknown'}
                </strong>
                </div>
            )}
            {gameState.currentRollerId === myId && (
                <button
                type="button"
                onClick={handleRoll}
                disabled={isRolling || myRoll !== null}
                style={{
                    padding: '0.75rem 1.5rem',
                    fontSize: '1.1rem',
                    backgroundColor: isRolling || myRoll !== null ? '#ccc' : '#007bff',
                    color: 'white',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: isRolling || myRoll !== null ? 'not-allowed' : 'pointer',
                    marginBottom: '1rem'
                }}
                >
                {myRoll !== null ? `You rolled: ${myRoll}` : isRolling ? 'Rolling...' : 'Roll Dice'}
                </button>
            )}
            {gameState.currentRollerId !== myId && (
                <p style={{ marginBottom: '1rem', color: '#666' }}>
                Waiting for {gameState.currentRollerId ? gameState.players[gameState.currentRollerId]?.username : 'a player'} to roll...
                </p>
            )}
            {isRolling && (
                <div style={{ fontSize: '2rem', marginBottom: '1rem', animation: 'spin 0.1s infinite' }}>
                🎲 🎲
                </div>
            )}
            <div style={{ marginTop: '1.5rem' }}>
                <h4>Roll Results:</h4>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '0.5rem' }}>
                {gameState?.diceRolls && Object.entries(gameState.diceRolls).length > 0 ? (
                    Object.entries(gameState.diceRolls).map(([playerId, roll]) => {
                    const player = gameState.players[playerId];
                    return (
                        <div key={playerId} style={{ padding: '0.75rem', backgroundColor: 'white', borderRadius: '4px', border: '1px solid #ddd' }}>
                        <div style={{ fontWeight: 'bold' }}>{player.username || 'Player'}</div>
                        <div style={{ fontSize: '1.5rem', color: '#007bff' }}>{roll}</div>
                        </div>
                    );
                    })
                ) : (
                    <p style={{ color: '#999' }}>No rolls yet...</p>
                )}
                </div>
            </div>
            <style>{`@keyframes spin {0% { transform: rotateX(0deg) rotateY(0deg); }100% { transform: rotateX(360deg) rotateY(360deg); }}`}</style>
        </div>
    );
}