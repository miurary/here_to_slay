import type { GameState } from '../../../../shared/types';
import { getCardTypeLabel } from '../../utils/gameUtils';

interface PartyLeaderReviewCardProps {
    gameState: GameState;
    myId: string;
    handleContinue: () => void;
}

export default function PartyLeaderReviewCard({ gameState, myId, handleContinue }: PartyLeaderReviewCardProps) {
    return (
        <div className="panel panelAccentGreen">
            <h2>Party Leader Review</h2>
            <p style={{ fontSize: '1rem', marginBottom: '1rem' }}>
                All players have chosen their party leaders. Review the choices below before continuing into the game.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem', marginBottom: '1rem' }}>
                {Object.values(gameState.players).map((player) => {
                const chosen = player.zones.party[0];
                const template = chosen ? gameState.cardTemplates[chosen.templateId] : undefined;
                return (
                    <div key={player.id} style={{ padding: '1rem', backgroundColor: 'white', borderRadius: '4px', border: '1px solid #ddd' }}>
                    <div style={{ fontWeight: 'bold', marginBottom: '0.5rem' }}>{player.username || 'Player'}</div>
                    {chosen ? (
                        <>
                        <div style={{ fontSize: '1rem', marginBottom: '0.25rem' }}>{template?.name || chosen.templateId}</div>
                        <div style={{ fontSize: '0.8rem', color: '#666' }}>{getCardTypeLabel(chosen, template)}</div>
                        <div style={{ marginTop: '0.5rem', fontSize: '0.75rem', color: '#333' }}>{(template?.abilityText as string) || 'No ability text available.'}</div>
                        </>
                    ) : (
                        <div style={{ color: '#999' }}>No party leader chosen</div>
                    )}
                    </div>
                );
                })}
            </div>
            <div style={{ marginBottom: '1.5rem' }}>
                <h3>Revealed Monsters</h3>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '0.75rem' }}>
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
                    <div key={monster.instanceId} style={{ padding: '1rem', backgroundColor: 'white', borderRadius: '8px', border: '1px solid #ddd' }}>
                        <div style={{ fontWeight: 'bold', marginBottom: '0.5rem' }}>{template?.name || monster.templateId}</div>
                        <div style={{ fontSize: '0.75rem', color: '#666', marginBottom: '0.75rem' }}>{requirementText}</div>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', marginBottom: '0.25rem' }}>
                        <span style={{ fontWeight: 'bold' }}>{lowerBound !== undefined ? `${lowerBound}-` : 'Lower:'}</span>
                        <span style={{ fontSize: '0.85rem', color: '#333' }}>{lowerBoundText ?? 'No lower bound text'}</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', marginBottom: '0.75rem' }}>
                        <span style={{ fontWeight: 'bold' }}>{upperBound !== undefined ? `${upperBound}+` : 'Upper:'}</span>
                        <span style={{ fontSize: '0.85rem', color: '#333' }}>{upperBoundText ?? 'No upper bound text'}</span>
                        </div>
                        {slainEffectText && (
                        <div style={{ marginTop: '0.5rem', padding: '0.75rem', borderRadius: '6px', backgroundColor: '#f8f0ff', color: '#333' }}>
                            <div style={{ fontWeight: 'bold', marginBottom: '0.25rem' }}>Slain Effect</div>
                            <div style={{ fontSize: '0.8rem' }}>{slainEffectText}</div>
                        </div>
                        )}
                    </div>
                    );
                })}
                </div>
            </div>
            {gameState.lobbyLeaderId === myId ? (
                <button type="button" onClick={handleContinue} style={{ padding: '0.75rem 1.5rem', fontSize: '1.1rem', backgroundColor: '#20c997', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>
                Continue to Game
                </button>
            ) : (
                <p style={{ color: '#666' }}>
                Waiting for {gameState.lobbyLeaderId ? gameState.players[gameState.lobbyLeaderId]?.username : 'the lobby leader'} to continue to the game...
                </p>
            )}
        </div>
    );
}