import type { GameState } from '../../../../shared/types';
import DiceRoll from './DiceRoll';

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
                <div style={{ marginBottom: '1.5rem', padding: '1rem', backgroundColor: 'oklch(0.24 0.015 260)', borderRadius: '8px', border: '1px solid oklch(0.6 0.13 85)' }}>
                <strong style={{ color: 'oklch(0.8 0.11 85)', fontSize: '1.1rem' }}>
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
                    fontWeight: 700,
                    backgroundColor: isRolling || myRoll !== null ? 'oklch(0.32 0.015 260)' : 'oklch(0.78 0.1 85)',
                    color: isRolling || myRoll !== null ? '#9aa0ad' : 'oklch(0.2 0.02 85)',
                    border: 'none',
                    borderRadius: '8px',
                    cursor: isRolling || myRoll !== null ? 'not-allowed' : 'pointer',
                    marginBottom: '1rem'
                }}
                >
                {myRoll !== null ? `You rolled: ${myRoll}` : isRolling ? 'Rolling...' : 'Roll Dice'}
                </button>
            )}
            {gameState.currentRollerId !== myId && (
                <p style={{ marginBottom: '1rem', color: '#9aa0ad' }}>
                Waiting for {gameState.currentRollerId ? gameState.players[gameState.currentRollerId]?.username : 'a player'} to roll...
                </p>
            )}
            {(isRolling || myRoll !== null) && (() => {
                // Derive a face pair that sums to the rolled total for the settle.
                const d1 = myRoll !== null ? Math.min(6, Math.max(1, myRoll - 1)) : undefined;
                const d2 = myRoll !== null && d1 !== undefined ? myRoll - d1 : undefined;
                return (
                    <div style={{ marginBottom: '1rem' }}>
                        <DiceRoll rolling={isRolling} die1={d1} die2={d2} size={48} />
                    </div>
                );
            })()}
            <div style={{ marginTop: '1.5rem' }}>
                <h4>Roll Results:</h4>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '0.5rem' }}>
                {gameState?.diceRolls && Object.entries(gameState.diceRolls).length > 0 ? (
                    Object.entries(gameState.diceRolls).map(([playerId, roll]) => {
                    const player = gameState.players[playerId];
                    return (
                        <div key={playerId} style={{ padding: '0.75rem', backgroundColor: 'oklch(0.24 0.015 260)', borderRadius: '8px', border: '1px solid oklch(0.34 0.015 260)' }}>
                        <div style={{ fontWeight: 'bold' }}>{player.username || 'Player'}</div>
                        <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'oklch(0.78 0.1 85)' }}>{roll}</div>
                        </div>
                    );
                    })
                ) : (
                    <p style={{ color: '#9aa0ad' }}>No rolls yet...</p>
                )}
                </div>
            </div>
        </div>
    );
}