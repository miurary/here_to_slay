import type { GameState } from "../../../../shared/types";

interface DiscardPileCardProps {
  gameState: GameState | null;
  myId: string;
  setActionMessage: (msg: string | null) => void;
  showDiscardPile: boolean;
  setShowDiscardPile: (val: boolean) => void;
}

export default function DiscardPileCard({ gameState, myId, setActionMessage, showDiscardPile, setShowDiscardPile }: DiscardPileCardProps) {
  const count = gameState ? gameState.discardPile.length : 0;

  return (
    <div style={{ marginTop: '1rem' }}>
      <h3>Discard Pile</h3>
      <div
        onClick={() => {
          if (!gameState) return;
          setShowDiscardPile(true);
        }}
        style={{ width: '120px', height: '160px', backgroundColor: '#3b3b3b', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '6px', cursor: 'pointer' }}
      >
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontWeight: 'bold' }}>Discard</div>
          <div style={{ fontSize: '0.9rem' }}>{count} cards</div>
        </div>
      </div>

      {showDiscardPile && gameState && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }}>
          <div style={{ backgroundColor: 'white', padding: '1rem', borderRadius: '12px', width: 'min(90vw, 640px)', maxHeight: '80vh', overflowY: 'auto' }}>
            <h3 style={{ marginTop: 0 }}>Discard Pile</h3>
            {gameState.discardPile.length === 0 && <div>No cards in discard pile</div>}
            <ul>
              {gameState.discardPile.map((card) => (
                <li key={card.instanceId} style={{ marginBottom: '0.5rem' }}>{gameState.cardTemplates[card.templateId]?.name || card.templateId} ({card.cardType})</li>
              ))}
            </ul>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
              <button onClick={() => setShowDiscardPile(false)} style={{ padding: '0.5rem 1rem' }}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
