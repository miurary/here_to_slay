import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { GameState, LogEntry } from "../../../../shared/types";
import { getClassColor } from "../../utils/classColors";
import { getPlayerColor } from "../../utils/gameUtils";

interface ChatLogPanelProps {
    gameState: GameState;
    entries: LogEntry[];
    myId: string;
    onSend: (message: string) => void;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** name (lowercased) -> class color, plus a matcher, for hero & party-leader names. */
type NameColorIndex = { colors: Map<string, string>; regex: RegExp | null };

function buildNameColorIndex(cardTemplates: GameState['cardTemplates'], players: GameState['players']): NameColorIndex {
    const colors = new Map<string, string>();
    // Hero & party-leader card names → their class color.
    for (const t of Object.values(cardTemplates)) {
        if ((t.type === 'hero' || t.type === 'party_leader') && t.name && t.class) {
            colors.set(t.name.toLowerCase(), getClassColor(t.class));
        }
    }
    // Player names → their party-leader color. Added last so a username that
    // happens to match a card name reads as the player.
    for (const p of Object.values(players)) {
        if (!p.username) continue;
        const cls = p.partyLeaderId ? cardTemplates[p.partyLeaderId]?.class : undefined;
        colors.set(p.username.toLowerCase(), getClassColor(cls));
    }
    const names = [...colors.keys()];
    if (names.length === 0) return { colors, regex: null };
    // Longest first so multi-word names win over any shorter substring.
    names.sort((a, b) => b.length - a.length);
    const regex = new RegExp(`(${names.map(escapeRegExp).join('|')})`, 'gi');
    return { colors, regex };
}

/** Split text into nodes, wrapping hero/leader card names in their class color. */
function colorizeNames(text: string, index: NameColorIndex): ReactNode {
    if (!index.regex) return text;
    const parts = text.split(index.regex);
    return parts.map((part, i) => {
        const color = index.colors.get(part.toLowerCase());
        return color
            ? <span key={i} style={{ color, fontWeight: 600 }}>{part}</span>
            : <span key={i}>{part}</span>;
    });
}

function Feed({ gameState, entries, myId, nameIndex, style }: { gameState: GameState; entries: LogEntry[]; myId: string; nameIndex: NameColorIndex; style?: React.CSSProperties }) {
    const endRef = useRef<HTMLDivElement | null>(null);

    // Keep the newest entry in view as the feed grows.
    useEffect(() => {
        endRef.current?.scrollIntoView({ block: 'end' });
    }, [entries.length]);

    return (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0.4rem 0.5rem', display: 'flex', flexDirection: 'column', gap: '0.25rem', ...style }}>
            {entries.length === 0 ? (
                <div style={{ color: '#94a3b8', fontSize: '0.8rem', fontStyle: 'italic' }}>No messages yet. Say hello!</div>
            ) : (
                entries.map((e) => {
                    if (e.kind === 'chat') {
                        const color = e.playerId === myId ? '#2563eb' : getPlayerColor(gameState, e.playerId);
                        return (
                            <div key={e.id} style={{ fontSize: '0.82rem', lineHeight: 1.3 }}>
                                <span style={{ fontWeight: 700, color }}>{e.username || 'Player'}: </span>
                                <span style={{ color: '#1e293b', wordBreak: 'break-word' }}>{e.text}</span>
                            </div>
                        );
                    }
                    // action / system entries: muted log lines with colored card names
                    return (
                        <div key={e.id} style={{ fontSize: '0.76rem', color: '#64748b', fontStyle: 'italic', lineHeight: 1.3 }}>
                            {colorizeNames(e.text, nameIndex)}
                        </div>
                    );
                })
            )}
            <div ref={endRef} />
        </div>
    );
}

export default function ChatLogPanel({ gameState, entries, myId, onSend }: ChatLogPanelProps) {
    const [draft, setDraft] = useState('');
    const [expanded, setExpanded] = useState(false);
    const nameIndex = useMemo(() => buildNameColorIndex(gameState.cardTemplates, gameState.players), [gameState.cardTemplates, gameState.players]);

    const submit = (e: FormEvent) => {
        e.preventDefault();
        const text = draft.trim();
        if (!text) return;
        onSend(text);
        setDraft('');
    };

    const inputRow = (
        <form onSubmit={submit} style={{ display: 'flex', gap: '0.35rem', padding: '0.4rem', borderTop: '1px solid #e2e8f0' }}>
            <input
                type="text"
                value={draft}
                onChange={(ev) => setDraft(ev.target.value)}
                placeholder="Chat…"
                maxLength={500}
                style={{ flex: 1, minWidth: 0, padding: '0.35rem 0.5rem', fontSize: '0.82rem', border: '1px solid #cbd5e1', borderRadius: '6px' }}
            />
            <button type="submit" style={{ padding: '0.35rem 0.7rem', fontSize: '0.8rem', fontWeight: 700, color: '#fff', background: '#2563eb', border: 'none', borderRadius: '6px', cursor: 'pointer' }}>
                Send
            </button>
        </form>
    );

    const header = (onToggle: () => void, isExpanded: boolean) => (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.3rem 0.5rem', borderBottom: '1px solid #e2e8f0' }}>
            <span style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#475569' }}>Chat &amp; Log</span>
            <button
                type="button"
                onClick={onToggle}
                title={isExpanded ? 'Collapse' : 'Expand'}
                style={{ padding: '0.1rem 0.4rem', fontSize: '0.75rem', background: 'transparent', border: '1px solid #cbd5e1', borderRadius: '4px', cursor: 'pointer', color: '#475569' }}
            >
                {isExpanded ? '▾ Collapse' : '▴ Expand'}
            </button>
        </div>
    );

    return (
        <>
            {/* Docked panel — lives in the right column under the monsters */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, height: '100%', border: '1px solid #ddd', borderRadius: '8px', background: 'white', overflow: 'hidden' }}>
                {header(() => setExpanded(true), false)}
                <Feed gameState={gameState} entries={entries} myId={myId} nameIndex={nameIndex} />
                {inputRow}
            </div>

            {/* Expanded overlay — grows upward from the docked chat to cover the
                active monsters above, slightly translucent so you can tell there's
                still a board underneath. */}
            {expanded && (
                <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '70vh', zIndex: 50, background: 'rgba(255,255,255,0.92)', backdropFilter: 'blur(1px)', display: 'flex', flexDirection: 'column', border: '1px solid #cbd5e1', borderRadius: '8px', boxShadow: '0 8px 24px rgba(15,23,42,0.18)' }}>
                    {header(() => setExpanded(false), true)}
                    <Feed gameState={gameState} entries={entries} myId={myId} nameIndex={nameIndex} />
                    {inputRow}
                </div>
            )}
        </>
    );
}
