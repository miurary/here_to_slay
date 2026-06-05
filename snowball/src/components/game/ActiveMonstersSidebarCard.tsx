import type { GameState } from "../../../../shared/types";

interface ActiveMonstersSidebarCardProps {
    gameState: GameState;
}

export default function ActiveMonstersSidebarCard({gameState}: ActiveMonstersSidebarCardProps) {
    return (
        <div style={{ padding: '1rem', border: '1px solid #bbb', borderRadius: '8px', backgroundColor: 'white' }}>
            <h3>Active Monsters</h3>
            <div style={{ display: 'grid', gap: '0.75rem' }}>
            {gameState.activeMonsters.map((monster) => {
                const template = gameState.cardTemplates[monster.templateId];
                const requirements = (template?.requirements as Array<{ class?: string; amount?: number }> | undefined) ?? [];
                const requirementText = requirements.length > 0
                ? requirements.map((req) => `${req.amount ?? '?'} ${req.class ?? 'Any'}`).join(', ')
                : 'No requirements';
                const lowerBound = template?.lowerBound as number | undefined;
                const lowerBoundText = template?.lowerBoundText as string | undefined;
                const upperBound = template?.upperBound as number | undefined;
                const upperBoundText = template?.upperBoundText as string | undefined;
                const slainEffectText = template?.slainEffectText as string | undefined;
                return (
                <div key={monster.instanceId} style={{ padding: '0.75rem', border: '1px solid #ddd', borderRadius: '8px', backgroundColor: '#fafafa' }}>
                    <div style={{ fontWeight: 'bold', marginBottom: '0.35rem' }}>{template?.name || monster.templateId}</div>
                    <div style={{ fontSize: '0.8rem', color: '#666', marginBottom: '0.75rem' }}>{requirementText}</div>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', marginBottom: '0.25rem' }}>
                    <span style={{ fontWeight: 'bold' }}>{lowerBound !== undefined ? `${lowerBound}-` : 'Lower:'}</span>
                    <span style={{ fontSize: '0.85rem', color: '#333' }}>{lowerBoundText ?? 'No lower bound text'}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', marginBottom: '0.75rem' }}>
                    <span style={{ fontWeight: 'bold' }}>{upperBound !== undefined ? `${upperBound}+` : 'Upper:'}</span>
                    <span style={{ fontSize: '0.85rem', color: '#333' }}>{upperBoundText ?? 'No upper bound text'}</span>
                    </div>
                    {slainEffectText && (
                    <div style={{ marginTop: '0.5rem', padding: '0.75rem', borderRadius: '6px', backgroundColor: '#fff8e1', color: '#333' }}>
                        <div style={{ fontWeight: 'bold', marginBottom: '0.25rem' }}>Slain Effect</div>
                        <div style={{ fontSize: '0.8rem' }}>{slainEffectText}</div>
                    </div>
                    )}
                </div>
                );
            })}
            </div>
        </div>
    )
}