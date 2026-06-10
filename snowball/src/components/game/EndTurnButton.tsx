import type { GameState } from "../../../../shared/types";

interface EndTurnButtonProps {
    gameState: GameState;
    myId: string;
    handleEndTurn: () => void;
}

export default function EndTurnButton({gameState, myId, handleEndTurn}: EndTurnButtonProps) {
    if (gameState.activePlayerId !== myId) return null;
    return (
        <button
            type="button"
            onClick={handleEndTurn}
            style={{ width: '100%', boxSizing: 'border-box', padding: '0.75rem 1rem', fontSize: '1rem', backgroundColor: '#007bff', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer' }}
        >
            End Turn
        </button>
    );
}