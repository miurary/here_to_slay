import type { GameState } from '../../../../shared/types';

interface GameStatusCardProps {
    gameState: GameState;
    myId: string;
}

export default function GameStatusCard({ gameState, myId }: GameStatusCardProps) {
  return (
    <div className="panel statusPanel" style={{ display: 'flex', gap: '1.75rem', justifyContent: 'center', alignItems: 'center', flexWrap: 'wrap', padding: '10px 22px' }}>
        <p style={{ margin: 0 }}>
            Current turn: <strong>{gameState.activePlayerId ? gameState.players[gameState.activePlayerId]?.username || gameState.activePlayerId : 'None'}</strong>
            {gameState.activePlayerId === myId ? ' (your turn)' : ''}
        </p>
        <p style={{ margin: 0 }}>
            Turn #: <strong>{gameState.turnNumber ?? 0}</strong>
        </p>
        <p style={{ margin: 0 }}>
            Your AP: <strong>{gameState.players[myId]?.actionPoints ?? 0}</strong>
        </p>
    </div>
  );
}