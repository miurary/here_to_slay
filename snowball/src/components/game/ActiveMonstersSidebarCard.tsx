import type { GameState } from "../../../../shared/types";
import CardArt from "../CardArt";
import MonsterDetailModal from "./MonsterDetailModal";

interface ActiveMonstersSidebarCardProps {
    gameState: GameState;
    myId: string;
    isMyTurn: boolean;
    selectedMonsterId: string | null;
    setSelectedMonsterId: (id: string | null) => void;
    onAttackMonster: (monsterInstanceId: string) => void;
}

export default function ActiveMonstersSidebarCard({
    gameState,
    myId,
    isMyTurn,
    selectedMonsterId,
    setSelectedMonsterId,
    onAttackMonster,
}: ActiveMonstersSidebarCardProps) {
    const selectedMonster = selectedMonsterId
        ? gameState.activeMonsters.find((m) => m.instanceId === selectedMonsterId)
        : undefined;

    return (
        <div style={{ padding: '1rem', border: '1px solid #bbb', borderRadius: '8px', backgroundColor: 'white', height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0, boxSizing: 'border-box' }}>
            <h3 style={{ margin: '0 0 0.5rem' }}>Active Monsters</h3>
            {/* Cards each take an equal share of the column height (flex: 1) and the
                art scales to fit, so all monsters are visible without scrolling. */}
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {gameState.activeMonsters.map((monster) => {
                    const template = gameState.cardTemplates[monster.templateId];
                    return (
                        <div
                            key={monster.instanceId}
                            onClick={() => setSelectedMonsterId(monster.instanceId)}
                            title={template?.name}
                            style={{
                                flex: 1,
                                minHeight: 0,
                                padding: '0.4rem',
                                border: '2px solid #ddd',
                                borderRadius: '8px',
                                backgroundColor: '#fafafa',
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                            }}
                        >
                            <CardArt cardId={monster.templateId} name={template?.name} fit />
                        </div>
                    );
                })}
                {gameState.activeMonsters.length === 0 && (
                    <p style={{ color: '#888', fontSize: '0.85rem' }}>No active monsters.</p>
                )}
            </div>
            {selectedMonster && (
                <MonsterDetailModal
                    gameState={gameState}
                    myId={myId}
                    isMyTurn={isMyTurn}
                    monster={selectedMonster}
                    onAttackMonster={onAttackMonster}
                    onClose={() => setSelectedMonsterId(null)}
                />
            )}
        </div>
    );
}
