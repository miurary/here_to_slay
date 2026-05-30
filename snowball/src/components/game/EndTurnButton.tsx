import type { GameState } from "../../../../shared/types";

interface EndTurnButtonProps {
    gameState: GameState;
    myId: string;
    handleEndTurn: () => void;
}

export default function EndTurnButton({gameState, myId, handleEndTurn}: EndTurnButtonProps) {
    return (
        <div style={{ marginBottom: '1rem' }}>
            {gameState.activePlayerId === myId && (
            <button
                type="button"
                onClick={handleEndTurn}
                style={{ padding: '0.5rem 1rem', fontSize: '1rem', backgroundColor: '#007bff', color: 'white', border: 'none', borderRadius: '4px' }}
            >
                End Turn
            </button>
            )}
        </div>
    );
}