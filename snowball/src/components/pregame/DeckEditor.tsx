import { useMemo, useState } from 'react';
import type { CardTemplate, GameState } from '../../../../shared/types';
import { T } from '../game/table/tableUtils';

interface DeckEditorProps {
  gameState: GameState;
  /** Only the lobby leader may change exclusions; everyone else sees a read-only view. */
  isHost: boolean;
  onSetExclusions: (excludedTemplateIds: string[]) => void;
}

/** Main-deck categories, in display order. Cursed items share type 'item' but
    carry subtype 'cursed', so they get their own section. */
const CATEGORIES: Array<{ key: string; label: string; match: (t: CardTemplate) => boolean }> = [
  { key: 'hero', label: 'Heroes', match: (t) => t.type === 'hero' },
  { key: 'item', label: 'Items', match: (t) => t.type === 'item' && t.subtype !== 'cursed' },
  { key: 'cursed', label: 'Cursed Items', match: (t) => t.type === 'item' && t.subtype === 'cursed' },
  { key: 'magic', label: 'Magic', match: (t) => t.type === 'magic' },
  { key: 'modifier', label: 'Modifiers', match: (t) => t.type === 'modifier' },
  { key: 'challenge', label: 'Challenges', match: (t) => t.type === 'challenge' },
];

const copiesOf = (t: CardTemplate): number =>
  typeof t.deckCount === 'number' && t.deckCount > 0 ? t.deckCount : 1;

/**
 * Lobby deck editor: the host checks/unchecks the cards that make up the main
 * deck for the next game. Category checkboxes toggle a whole section at once.
 * Everything is included by default; the exclusion list lives on the server
 * (gameState.excludedCardIds) so all players see the same deck.
 */
export default function DeckEditor({ gameState, isHost, onSetExclusions }: DeckEditorProps) {
  const [open, setOpen] = useState(false);
  const excluded = useMemo(() => new Set(gameState.excludedCardIds ?? []), [gameState.excludedCardIds]);

  const sections = useMemo(() => {
    const templates = Object.values(gameState.cardTemplates);
    return CATEGORIES.map((cat) => {
      const cards = templates.filter(cat.match).sort((a, b) => a.name.localeCompare(b.name));
      return { ...cat, cards };
    }).filter((s) => s.cards.length > 0);
  }, [gameState.cardTemplates]);

  const totalCopies = sections.reduce((n, s) => n + s.cards.reduce((m, c) => m + copiesOf(c), 0), 0);
  const includedCopies = sections.reduce(
    (n, s) => n + s.cards.reduce((m, c) => m + (excluded.has(c.id) ? 0 : copiesOf(c)), 0), 0);

  const setExcluded = (ids: Set<string>) => onSetExclusions([...ids]);

  const toggleCard = (id: string) => {
    if (!isHost) return;
    const next = new Set(excluded);
    if (next.has(id)) next.delete(id); else next.add(id);
    setExcluded(next);
  };

  const toggleCategory = (cards: CardTemplate[], allIncluded: boolean) => {
    if (!isHost) return;
    const next = new Set(excluded);
    for (const c of cards) {
      if (allIncluded) next.add(c.id); else next.delete(c.id);
    }
    setExcluded(next);
  };

  const checkbox = (checked: boolean, indeterminate: boolean, onChange: () => void) => (
    <input
      type="checkbox"
      checked={checked}
      ref={(el) => { if (el) el.indeterminate = indeterminate; }}
      onChange={onChange}
      disabled={!isHost}
      style={{ accentColor: T.gold, width: 14, height: 14, cursor: isHost ? 'pointer' : 'default', flexShrink: 0 }}
    />
  );

  return (
    <div style={{ width: 650, borderRadius: 10, border: `1px solid ${T.border}`, background: T.cardBg, overflow: 'hidden' }}>
      <div
        onClick={() => setOpen((o) => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 14px', cursor: 'pointer', userSelect: 'none' }}
      >
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.18em', color: '#cfd8d0' }}>DECK</span>
        <span style={{ fontSize: 11.5, fontWeight: 700, color: includedCopies < totalCopies ? T.gold : '#c4ccc6' }}>
          {includedCopies}/{totalCopies} cards
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10.5, fontWeight: 700, color: T.gold }}>
          {open ? 'Hide ▴' : isHost ? 'Edit ▾' : 'View ▾'}
        </span>
      </div>

      {open && (
        <div style={{ maxHeight: 300, overflowY: 'auto', padding: '2px 14px 12px', borderTop: `1px solid ${T.border}` }}>
          {!isHost && (
            <div style={{ fontSize: 10.5, color: '#9aa19c', padding: '8px 0 2px' }}>
              Only the host can change the deck.
            </div>
          )}
          {sections.map((s) => {
            const excludedCount = s.cards.filter((c) => excluded.has(c.id)).length;
            const allIncluded = excludedCount === 0;
            const noneIncluded = excludedCount === s.cards.length;
            return (
              <div key={s.key}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 0 6px', cursor: isHost ? 'pointer' : 'default' }}>
                  {checkbox(!noneIncluded, !allIncluded && !noneIncluded, () => toggleCategory(s.cards, allIncluded))}
                  <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.1em', color: T.text, textTransform: 'uppercase' }}>{s.label}</span>
                  <span style={{ fontSize: 10.5, color: '#9aa19c' }}>{s.cards.length - excludedCount}/{s.cards.length}</span>
                </label>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '3px 12px' }}>
                  {s.cards.map((c) => {
                    const out = excluded.has(c.id);
                    return (
                      <label
                        key={c.id}
                        title={c.abilityText}
                        style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11.5, cursor: isHost ? 'pointer' : 'default', color: out ? T.disabled : T.text, textDecoration: out ? 'line-through' : 'none', overflow: 'hidden' }}
                      >
                        {checkbox(!out, false, () => toggleCard(c.id))}
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                        {copiesOf(c) > 1 && <span style={{ fontSize: 9.5, color: '#9aa19c', flexShrink: 0 }}>×{copiesOf(c)}</span>}
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
