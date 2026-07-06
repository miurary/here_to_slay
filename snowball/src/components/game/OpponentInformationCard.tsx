import type { Dispatch, SetStateAction } from 'react';
import type { GameState } from "../../../../shared/types";
import { getClassColor, HERO_CLASSES } from "../../utils/classColors";
import { getPlayerColor } from "../../utils/gameUtils";
import OpponentPartyModal from "./OpponentPartyModal";

interface OpponentInformationCardProps {
    gameState: GameState;
    myId: string;
    selectedOpponentPartyId: string | null;
    viewedItemId: string | null;
    setSelectedOpponentPartyId: Dispatch<SetStateAction<string | null>>;
    setViewedItemId: Dispatch<SetStateAction<string | null>>;
}

const dotBase: React.CSSProperties = {
    width: 10, height: 10, borderRadius: '50%', boxSizing: 'border-box', flex: '0 0 auto',
};

export default function OpponentInformationCard({ gameState, myId, selectedOpponentPartyId, viewedItemId, setSelectedOpponentPartyId, setViewedItemId }: OpponentInformationCardProps) {
    const targetMonsters = gameState.targetMonstersToWin ?? 3;

    return (
        <div style={{ padding: '0.5rem 0.625rem', border: '1px solid #bbb', borderRadius: '8px', backgroundColor: 'white' }}>
            <h4 style={{ margin: '0 0 0.4rem', fontSize: '0.8rem', color: '#475569' }}>Opponents' Parties</h4>
            {/* The container is a fixed width (see .gameHeaderOpponents); each card
                sizes to its content (as small as possible) and is left-aligned. */}
            <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'stretch', flexWrap: 'wrap' }}>
            {Object.values(gameState.players)
                .filter((player) => player.id !== myId)
                .map((player) => {
                // Which hero classes the player has covered — counts the party
                // leader plus every card in the party zone (not a per-card count).
                const presentClasses = new Set<string>();
                const leaderClass = player.partyLeaderId
                    ? gameState.cardTemplates[player.partyLeaderId]?.class
                    : undefined;
                if (leaderClass) presentClasses.add(leaderClass.toLowerCase());
                for (const card of player.zones.party) {
                    const cls = gameState.cardTemplates[card.templateId]?.class;
                    if (cls) presentClasses.add(cls.toLowerCase());
                }
                const slainCount = player.slainMonsters?.length ?? 0;
                return (
                    <div
                        key={player.id}
                        style={{ flex: '0 0 auto', width: 'min-content', padding: '0.35rem 0.45rem', border: '1px solid #ddd', borderRadius: '6px', backgroundColor: '#fafafa', display: 'flex', flexDirection: 'column', gap: '0.3rem' }}
                    >
                        {/* Row 1: name + View button */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.4rem' }}>
                            <div style={{ fontWeight: 'bold', fontSize: '0.8rem', color: getPlayerColor(gameState, player.id), minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {player.username || 'Player'}
                            </div>
                            <button
                                type="button"
                                onClick={() => setSelectedOpponentPartyId(player.id)}
                                style={{ padding: '0.1rem 0.4rem', fontSize: '0.7rem', backgroundColor: '#007bff', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', flex: '0 0 auto' }}
                            >
                                View
                            </button>
                        </div>
                        {/* Row 2: one dot per class — lit in the class color when the
                            player has that class covered, otherwise an empty outline. */}
                        <div title="Hero classes in party" style={{ display: 'flex', alignItems: 'center', gap: '0.2rem', flexWrap: 'nowrap' }}>
                            {HERO_CLASSES.map((cls) => {
                                const present = presentClasses.has(cls);
                                return (
                                    <span
                                        key={cls}
                                        title={`${cls}${present ? '' : ' (missing)'}`}
                                        style={{
                                            ...dotBase,
                                            backgroundColor: present ? getClassColor(cls) : 'transparent',
                                            border: present ? 'none' : '1px solid #ccc',
                                        }}
                                    />
                                );
                            })}
                        </div>
                        {/* Row 3: hand size (left) + monster tracker (right) */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.4rem', marginTop: 'auto' }}>
                            <div title="Cards in hand" style={{ fontSize: '0.7rem', color: '#333', flex: '0 0 auto' }}>
                                ✋ {player.zones.hand.length}
                            </div>
                            <div title={`${slainCount} of ${targetMonsters} monsters slain`} style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                                {Array.from({ length: targetMonsters }).map((_, i) => (
                                    <span
                                        key={i}
                                        style={{
                                            ...dotBase,
                                            backgroundColor: i < slainCount ? '#212529' : 'transparent',
                                            border: '2px solid #212529',
                                        }}
                                    />
                                ))}
                            </div>
                        </div>
                    </div>
                );
                })}
            </div>
            {selectedOpponentPartyId && gameState.players[selectedOpponentPartyId] && (
                <OpponentPartyModal
                    gameState={gameState}
                    playerId={selectedOpponentPartyId}
                    viewedItemId={viewedItemId}
                    setViewedItemId={setViewedItemId}
                    onClose={() => { setSelectedOpponentPartyId(null); setViewedItemId(null); }}
                />
            )}
        </div>
    )
}
