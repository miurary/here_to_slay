import type { GameState } from "../../../../shared/types";

interface MainDeckCardProps {
    gameState: GameState;
    myId: string;
    showDrawPrompt: boolean;
    setShowDrawPrompt: (val: boolean) => void;
    handleDrawFromMain: () => void;
    handleMulligan: () => void;
}

const overlayStyle: React.CSSProperties = {
    position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)',
    display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000,
};
const panelStyle: React.CSSProperties = {
    backgroundColor: 'white', padding: '1.5rem', borderRadius: '12px',
    width: 'min(90vw, 360px)', boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
    display: 'flex', flexDirection: 'column', gap: '0.75rem',
};

export default function MainDeckCard({ gameState, myId, showDrawPrompt, setShowDrawPrompt, handleDrawFromMain, handleMulligan }: MainDeckCardProps) {
    const myAP = gameState.players[myId]?.actionPoints ?? 0;
    const canMulligan = myAP >= 3 && gameState.mainDeck.length >= 5;
    const canDraw = gameState.status === 'in_progress' && gameState.activePlayerId === myId;

    return (
        <div style={{ margin: 0 }}>
            <h3 style={{ marginBottom: '0.5rem' }}>Main Deck</h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <div
                onClick={canDraw ? () => setShowDrawPrompt(true) : undefined}
                style={{ width: '120px', height: '160px', backgroundColor: '#2e2e2e', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '6px', cursor: canDraw ? 'pointer' : 'default' }}
            >
                <div style={{ textAlign: 'center' }}>
                <div style={{ fontWeight: 'bold' }}>Deck</div>
                <div style={{ fontSize: '0.9rem' }}>{gameState.mainDeck.length} cards</div>
                </div>
            </div>
            </div>

            {showDrawPrompt && (
                <div style={overlayStyle} onClick={() => setShowDrawPrompt(false)}>
                    <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <h3 style={{ margin: 0 }}>Main Deck</h3>
                            <span style={{ fontSize: '0.85rem', color: '#666' }}>{gameState.mainDeck.length} cards · {myAP} AP</span>
                        </div>
                        <button
                            onClick={() => {
                                if (myAP >= 1) handleDrawFromMain();
                                setShowDrawPrompt(false);
                            }}
                            disabled={myAP < 1}
                            style={{ padding: '0.6rem 1rem', fontSize: '1rem', cursor: myAP >= 1 ? 'pointer' : 'not-allowed' }}
                        >
                            Draw 1 card (-1 AP)
                        </button>
                        <button
                            onClick={() => {
                                if (canMulligan) handleMulligan();
                                setShowDrawPrompt(false);
                            }}
                            disabled={!canMulligan}
                            style={{ padding: '0.6rem 1rem', fontSize: '1rem', cursor: canMulligan ? 'pointer' : 'not-allowed', backgroundColor: canMulligan ? '#6c757d' : undefined }}
                        >
                            Mulligan (-3 AP)
                        </button>
                        {myAP < 3 && (
                            <div style={{ color: '#c00', fontSize: '0.85rem' }}>Need 3 AP to mulligan</div>
                        )}
                        {gameState.mainDeck.length < 5 && myAP >= 3 && (
                            <div style={{ color: '#c00', fontSize: '0.85rem' }}>Not enough cards in deck</div>
                        )}
                        <button
                            type="button"
                            onClick={() => setShowDrawPrompt(false)}
                            style={{ padding: '0.5rem 1rem', fontSize: '0.9rem', backgroundColor: '#6c757d', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer' }}
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            )}
        </div>
    )
}