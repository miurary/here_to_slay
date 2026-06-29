import type { CardInstance, CardTemplate, GameState, PlayerState } from "../../../../shared/types";
import CardArt from "../CardArt";

interface ActiveMonstersSidebarCardProps {
    gameState: GameState;
    myId: string;
    isMyTurn: boolean;
    selectedMonsterId: string | null;
    setSelectedMonsterId: (id: string | null) => void;
    onAttackMonster: (monsterInstanceId: string) => void;
}

function getEffectiveClass(card: CardInstance, gameState: GameState, player: PlayerState): string | undefined {
    const template = gameState.cardTemplates[card.templateId];
    const baseClass = template?.class;
    if (!card.equippedItem) return baseClass;
    const itemInst = player.zones.party.find(c => c.instanceId === card.equippedItem);
    if (!itemInst) return baseClass;
    const itemTemplate = gameState.cardTemplates[itemInst.templateId];
    const passives = itemTemplate?.passiveModifiers;
    return passives?.find(p => p.stat === 'class' && p.override)?.override ?? baseClass;
}

function checkRequirements(
    player: PlayerState,
    monsterTemplate: CardTemplate | undefined,
    gameState: GameState
): { met: boolean; items: Array<{ label: string; met: boolean }> } {
    const reqs = monsterTemplate?.requirements ?? [];
    const items: Array<{ label: string; met: boolean }> = [];

    for (const req of reqs) {
        const classLower = req.class.toLowerCase();
        if (classLower === 'hero') {
            const count = player.zones.party.filter(c => c.cardType === 'hero').length;
            items.push({ label: `${req.amount} hero card${req.amount > 1 ? 's' : ''} (have ${count})`, met: count >= req.amount });
        } else {
            const count = player.zones.party.filter(c => {
                const effectiveClass = getEffectiveClass(c, gameState, player);
                return effectiveClass?.toLowerCase() === classLower;
            }).length;
            items.push({ label: `${req.amount} ${req.class} hero${req.amount > 1 ? 's' : ''} (have ${count})`, met: count >= req.amount });
        }
    }

    return { met: items.every(i => i.met), items };
}

export default function ActiveMonstersSidebarCard({
    gameState,
    myId,
    isMyTurn,
    selectedMonsterId,
    setSelectedMonsterId,
    onAttackMonster,
}: ActiveMonstersSidebarCardProps) {
    const myPlayer = gameState.players[myId];

    return (
        <div style={{ padding: '1rem', border: '1px solid #bbb', borderRadius: '8px', backgroundColor: 'white' }}>
            <h3>Active Monsters</h3>
            <div style={{ display: 'grid', gap: '0.75rem' }}>
                {gameState.activeMonsters.map((monster) => {
                    const template = gameState.cardTemplates[monster.templateId];
                    const isSelected = selectedMonsterId === monster.instanceId;

                    const reqResult = myPlayer
                        ? checkRequirements(myPlayer, template, gameState)
                        : { met: false, items: [] };

                    const canAttack = isMyTurn && (myPlayer?.actionPoints ?? 0) >= 2 && reqResult.met;
                    const notEnoughAP = isMyTurn && (myPlayer?.actionPoints ?? 0) < 2;

                    return (
                        <div
                            key={monster.instanceId}
                            onClick={() => setSelectedMonsterId(isSelected ? null : monster.instanceId)}
                            style={{
                                padding: '0.75rem',
                                border: `2px solid ${isSelected ? '#007bff' : '#ddd'}`,
                                borderRadius: '8px',
                                backgroundColor: isSelected ? '#e7f3ff' : '#fafafa',
                                cursor: 'pointer',
                            }}
                        >
                            <CardArt cardId={monster.templateId} name={template?.name} style={{ margin: '0 auto 0.5rem' }} />

                            {isSelected && myPlayer && (
                                <div
                                    onClick={e => e.stopPropagation()}
                                    style={{ marginTop: '0.75rem', paddingTop: '0.75rem', borderTop: '1px solid #cce0ff' }}
                                >
                                    <div style={{ fontSize: '0.8rem', fontWeight: 'bold', marginBottom: '0.4rem', color: '#444' }}>Requirements:</div>
                                    {reqResult.items.length === 0 ? (
                                        <div style={{ fontSize: '0.8rem', color: '#28a745' }}>None</div>
                                    ) : (
                                        reqResult.items.map((item, i) => (
                                            <div key={i} style={{ fontSize: '0.8rem', color: item.met ? '#28a745' : '#c00', marginBottom: '0.15rem' }}>
                                                {item.met ? '✓' : '✗'} {item.label}
                                            </div>
                                        ))
                                    )}

                                    {!isMyTurn && (
                                        <div style={{ fontSize: '0.8rem', color: '#888', marginTop: '0.5rem' }}>
                                            Only available on your turn.
                                        </div>
                                    )}
                                    {notEnoughAP && (
                                        <div style={{ fontSize: '0.8rem', color: '#c00', marginTop: '0.5rem' }}>
                                            Need 2 AP to attack.
                                        </div>
                                    )}
                                    {!reqResult.met && isMyTurn && (
                                        <div style={{ fontSize: '0.8rem', color: '#c00', marginTop: '0.25rem' }}>
                                            Requirements not met.
                                        </div>
                                    )}

                                    <button
                                        type="button"
                                        disabled={!canAttack}
                                        onClick={() => {
                                            onAttackMonster(monster.instanceId);
                                            setSelectedMonsterId(null);
                                        }}
                                        style={{
                                            marginTop: '0.6rem',
                                            padding: '0.5rem 1rem',
                                            borderRadius: '6px',
                                            border: 'none',
                                            backgroundColor: canAttack ? '#dc3545' : '#ccc',
                                            color: 'white',
                                            cursor: canAttack ? 'pointer' : 'not-allowed',
                                            fontWeight: 'bold',
                                            width: '100%',
                                            fontSize: '0.9rem',
                                        }}
                                    >
                                        Attack (2 AP)
                                    </button>
                                </div>
                            )}
                        </div>
                    );
                })}
                {gameState.activeMonsters.length === 0 && (
                    <p style={{ color: '#888', fontSize: '0.85rem' }}>No active monsters.</p>
                )}
            </div>
        </div>
    );
}
