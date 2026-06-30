import type { GameState } from '../../../../shared/types';
import { getPlayerColor } from '../../utils/gameUtils';

interface GameStatusCardProps {
    gameState: GameState;
    myId: string;
}

export default function GameStatusCard({ gameState, myId }: GameStatusCardProps) {
  const isMyTurn = gameState.activePlayerId === myId;
  const activeId = gameState.activePlayerId;
  return (
    <div className="panel statusPanel" style={{ display: 'flex', gap: '0.85rem', justifyContent: 'center', alignItems: 'center', flexWrap: 'nowrap', padding: '6px 12px', fontSize: '0.8rem', border: `2px solid ${isMyTurn ? '#2563eb' : '#e2e8f0'}` }}>
        <p style={{ margin: 0, whiteSpace: 'nowrap' }}>
            Current turn: <strong style={{ color: activeId ? getPlayerColor(gameState, activeId) : undefined }}>{activeId ? gameState.players[activeId]?.username || activeId : 'None'}</strong>
            {activeId === myId ? ' (your turn)' : ''}
        </p>
        <p style={{ margin: 0, whiteSpace: 'nowrap' }}>
            Turn #: <strong>{gameState.turnNumber ?? 0}</strong>
        </p>
        <p style={{ margin: 0, whiteSpace: 'nowrap' }}>
            AP: <strong>{gameState.players[myId]?.actionPoints ?? 0}</strong>
        </p>
    </div>
  );
}