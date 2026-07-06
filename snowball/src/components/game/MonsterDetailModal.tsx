import type { CardInstance, CardTemplate, GameState, PlayerState } from "../../../../shared/types";
import CardArt from "../CardArt";

interface MonsterDetailModalProps {
    gameState: GameState;
    myId: string;
    isMyTurn: boolean;
    monster: CardInstance;
    onAttackMonster: (monsterInstanceId: string) => void;
    onClose: () => void;
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

const overlayStyle: React.CSSProperties = {
    position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)',
    display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000,
};
const panelStyle: React.CSSProperties = {
    backgroundColor: 'white', padding: '1.5rem', borderRadius: '12px',
    width: 'min(92vw, 460px)', maxHeight: '90vh', overflowY: 'auto',
    boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
};

export default function MonsterDetailModal({ gameState, myId, isMyTurn, monster, onAttackMonster, onClose }: MonsterDetailModalProps) {
    const myPlayer = gameState.players[myId];
    const template = gameState.cardTemplates[monster.templateId];

    const reqResult = myPlayer
        ? checkRequirements(myPlayer, template, gameState)
        : { met: false, items: [] };

    const canAttack = isMyTurn && (myPlayer?.actionPoints ?? 0) >= 2 && reqResult.met;
    const notEnoughAP = isMyTurn && (myPlayer?.actionPoints ?? 0) < 2;

    return (
        <div style={overlayStyle} onClick={onClose}>
            <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '0.5rem' }}>
                    <button type="button" onClick={onClose} className="primaryButton">Close</button>
                </div>

                <CardArt cardId={monster.templateId} name={template?.name} style={{ width: 'min(72vw, 300px)', margin: '0 auto 1rem' }} />

                <div style={{ fontSize: '0.85rem', fontWeight: 'bold', marginBottom: '0.4rem', color: '#444' }}>Requirements:</div>
                {reqResult.items.length === 0 ? (
                    <div style={{ fontSize: '0.85rem', color: '#28a745' }}>None</div>
                ) : (
                    reqResult.items.map((item, i) => (
                        <div key={i} style={{ fontSize: '0.85rem', color: item.met ? '#28a745' : '#c00', marginBottom: '0.2rem' }}>
                            {item.met ? '✓' : '✗'} {item.label}
                        </div>
                    ))
                )}

                {!isMyTurn && (
                    <div style={{ fontSize: '0.85rem', color: '#888', marginTop: '0.5rem' }}>
                        Only available on your turn.
                    </div>
                )}
                {notEnoughAP && (
                    <div style={{ fontSize: '0.85rem', color: '#c00', marginTop: '0.5rem' }}>
                        Need 2 AP to attack.
                    </div>
                )}
                {!reqResult.met && isMyTurn && (
                    <div style={{ fontSize: '0.85rem', color: '#c00', marginTop: '0.25rem' }}>
                        Requirements not met.
                    </div>
                )}

                <button
                    type="button"
                    disabled={!canAttack}
                    onClick={() => {
                        onAttackMonster(monster.instanceId);
                        onClose();
                    }}
                    style={{
                        marginTop: '0.75rem',
                        padding: '0.6rem 1rem',
                        borderRadius: '6px',
                        border: 'none',
                        backgroundColor: canAttack ? '#dc3545' : '#ccc',
                        color: 'white',
                        cursor: canAttack ? 'pointer' : 'not-allowed',
                        fontWeight: 'bold',
                        width: '100%',
                        fontSize: '0.95rem',
                    }}
                >
                    Attack (2 AP)
                </button>
            </div>
        </div>
    );
}
