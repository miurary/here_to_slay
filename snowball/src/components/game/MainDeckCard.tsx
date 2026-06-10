import type { GameState } from "../../../../shared/types";

interface MainDeckCardProps {
    gameState: GameState;
    myId: string;
    showDrawPrompt: boolean;
    actionMessage: string | null;
    justDrew: boolean;
    setActionMessage: (message: string | null) => void;
    setShowDrawPrompt: (val: boolean) => void;
    handleDrawFromMain: () => void;
    handleMulligan: () => void;
}

export default function MainDeckCard({ gameState, myId, showDrawPrompt, actionMessage, justDrew, setActionMessage, setShowDrawPrompt, handleDrawFromMain, handleMulligan }: MainDeckCardProps) {
    return (
        <div style={{ margin: 0 }}>
            <h3 style={{ marginBottom: '0.5rem' }}>Main Deck</h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <div
                onClick={() => {
                if (gameState.status !== 'in_progress' || gameState.activePlayerId !== myId) {
                    setActionMessage('Not your turn to draw');
                    setTimeout(() => setActionMessage(null), 1800);
                    return;
                }
                setShowDrawPrompt(true);
                }}
                style={{ width: '120px', height: '160px', backgroundColor: '#2e2e2e', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '6px', cursor: gameState.activePlayerId === myId ? 'pointer' : 'not-allowed' }}
            >
                <div style={{ textAlign: 'center' }}>
                <div style={{ fontWeight: 'bold' }}>Deck</div>
                <div style={{ fontSize: '0.9rem' }}>{gameState.mainDeck.length} cards</div>
                </div>
            </div>

            {showDrawPrompt && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                <button
                    onClick={() => {
                    const myAP = gameState.players[myId]?.actionPoints ?? 0;
                    if (myAP >= 1) {
                        handleDrawFromMain();
                    }
                    setShowDrawPrompt(false);
                    }}
                    disabled={(gameState.players[myId]?.actionPoints ?? 0) < 1}
                    style={{ padding: '0.5rem 1rem', fontSize: '1rem' }}
                >
                    Draw 1 card (-1 AP)
                </button>
                <button
                    onClick={() => {
                    const myAP = gameState.players[myId]?.actionPoints ?? 0;
                    if (myAP >= 3) {
                        handleMulligan();
                    }
                    setShowDrawPrompt(false);
                    }}
                    disabled={(gameState.players[myId]?.actionPoints ?? 0) < 3 || gameState.mainDeck.length < 5}
                    style={{ padding: '0.5rem 1rem', fontSize: '1rem', backgroundColor: (gameState.players[myId]?.actionPoints ?? 0) >= 3 && gameState.mainDeck.length >= 5 ? '#6c757d' : undefined }}
                >
                    Mulligan (-3 AP)
                </button>
                {(gameState.players[myId]?.actionPoints ?? 0) < 3 && (
                    <div style={{ color: '#c00', fontSize: '0.85rem' }}>Need 3 AP to mulligan</div>
                )}
                {gameState.mainDeck.length < 5 && (gameState.players[myId]?.actionPoints ?? 0) >= 3 && (
                    <div style={{ color: '#c00', fontSize: '0.85rem' }}>Not enough cards in deck</div>
                )}
                </div>
            )}
            {actionMessage && (
                <div style={{ marginLeft: '1rem', color: '#a00', fontWeight: 'bold' }}>{actionMessage}</div>
            )}
            {justDrew && (
                <div style={{ marginLeft: '1rem', color: '#0a0', fontWeight: 'bold' }}>Drew a card!</div>
            )}
            </div>
        </div>
    )
}