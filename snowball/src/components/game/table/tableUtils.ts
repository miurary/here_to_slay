import type { CardInstance, CardTemplate, GameState, PlayerState } from '../../../../../shared/types';

/* ── Design tokens (exact values from the design handoff) ─────────────────── */
export const T = {
  gold: 'oklch(0.78 0.1 85)',
  goldHover: 'oklch(0.84 0.1 85)',
  onGold: 'oklch(0.2 0.02 85)',
  green: 'oklch(0.75 0.11 150)',
  red: 'oklch(0.68 0.15 25)',
  itemBlue: 'oklch(0.75 0.12 250)',
  magic: 'oklch(0.72 0.1 300)',

  text: '#e8e9ee',
  text2: '#b9bfc9',
  muted: '#9aa0ad',
  muted2: '#8f96a3',
  disabled: '#6f7683',

  pageBg: 'oklch(0.22 0.015 260)',
  headerBg: 'oklch(0.18 0.015 260)',
  drawerBg: 'oklch(0.19 0.015 260)',
  cardBg: 'oklch(0.26 0.015 260)',
  cardBg2: 'oklch(0.28 0.015 260)',
  feltPile: 'oklch(0.2 0.02 260)',
  border: 'oklch(0.34 0.015 260)',
} as const;

/** The four felt tints from the design; the first (green) is the default. */
export const FELT_COLORS = ['#2d5545', '#2d4155', '#4a2f35', '#33363c'] as const;
export const feltBackground = (felt: string) =>
  `radial-gradient(ellipse at 50% 40%, color-mix(in oklab, ${felt}, white 10%), color-mix(in oklab, ${felt}, black 18%))`;

/** Hue per hero class for the oklch(0.62 0.13 H) table palette. */
const CLASS_HUE: Record<string, number> = {
  bard: 60, wizard: 300, necromancer: 150, berserker: 25,
  guardian: 90, thief: 250, ranger: 130, warrior: 15, fighter: 15,
};

/** Class swatch in the table's oklch palette (falls back to a neutral slate). */
export const classColor = (cls?: string): string => {
  const h = cls ? CLASS_HUE[cls.toLowerCase()] : undefined;
  return h == null ? 'oklch(0.6 0.02 260)' : `oklch(0.62 0.13 ${h})`;
};

/** A card in a player's party may be re-classed by an equipped item (e.g. Ranger Mask). */
export function effectiveClass(card: CardInstance, gameState: GameState, player: PlayerState): string | undefined {
  const base = gameState.cardTemplates[card.templateId]?.class;
  if (!card.equippedItem) return base;
  const itemInst = player.zones.party.find((c) => c.instanceId === card.equippedItem);
  if (!itemInst) return base;
  const passives = gameState.cardTemplates[itemInst.templateId]?.passiveModifiers;
  return passives?.find((p) => p.stat === 'class' && p.override)?.override ?? base;
}

export interface MonsterReq { text: string; met: boolean; }

/** Per-requirement chip data + overall met flag for a monster, against my party. */
export function monsterRequirements(
  player: PlayerState | undefined,
  template: CardTemplate | undefined,
  gameState: GameState,
): { met: boolean; reqs: MonsterReq[] } {
  const reqs: MonsterReq[] = [];
  if (!player) return { met: false, reqs };
  for (const req of template?.requirements ?? []) {
    const cls = req.class.toLowerCase();
    let count: number;
    if (cls === 'hero') {
      count = player.zones.party.filter((c) => c.cardType === 'hero').length;
    } else {
      count = player.zones.party.filter((c) => effectiveClass(c, gameState, player)?.toLowerCase() === cls).length;
    }
    const label = cls === 'hero' ? `${req.amount} ${req.amount > 1 ? 'heroes' : 'hero'}` : `${req.amount} ${req.class}`;
    reqs.push({ text: `${label} ${count >= req.amount ? '✓' : '✗'}`, met: count >= req.amount });
  }
  return { met: reqs.every((r) => r.met), reqs };
}

/** Uppercase "TYPE · CLASS · N+"-style meta label for a hand/discard card + its color. */
export function cardMeta(card: CardInstance, template: CardTemplate | undefined): [string, string] {
  const cls = template?.class;
  const subtype = (template?.subtype as string | undefined)?.toLowerCase();
  switch (card.cardType) {
    case 'hero':
      return [`HERO · ${(cls ?? '').toUpperCase()} · ${template?.rollToPlay ?? '?'}+`, classColor(cls)];
    case 'magic':
      return ['MAGIC', T.magic];
    case 'item':
      return subtype === 'cursed' ? ['CURSED ITEM', T.red] : ['ITEM · EQUIP', T.itemBlue];
    case 'modifier':
      return ['MODIFIER · AFTER ROLLS', T.muted];
    case 'challenge':
      return ['CHALLENGE · REACTIVE', T.muted];
    default:
      return [card.cardType.toUpperCase(), T.muted];
  }
}

/** Cards that can be actively played from hand (cost 1 AP). Modifiers/challenges are reactive. */
export const isPlayableType = (t: string) => t === 'hero' || t === 'magic' || t === 'item';

export const isCursedItem = (template: CardTemplate | undefined) =>
  (template?.subtype as string | undefined)?.toLowerCase() === 'cursed';

export const displayName = (gameState: GameState, playerId?: string) =>
  (playerId ? gameState.players[playerId]?.username : undefined) || 'Player';

export const initialOf = (name: string) => (name.trim()[0] ?? '?').toUpperCase();

/* ── Shared button styles for the felt strips / action bar ────────────────── */
export const goldButton: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, background: T.gold, color: T.onGold,
  padding: '6px 14px', borderRadius: 7, cursor: 'pointer', whiteSpace: 'nowrap',
  border: `1px solid ${T.gold}`,
};
export const ghostButton: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, background: 'transparent', color: T.text2,
  border: `1px solid oklch(0.4 0.02 260)`, padding: '6px 13px', borderRadius: 7,
  cursor: 'pointer', whiteSpace: 'nowrap',
};
export const ghostGoldButton: React.CSSProperties = {
  fontSize: 10.5, fontWeight: 700, background: 'transparent', color: T.gold,
  border: `1px solid oklch(0.5 0.06 85)`, padding: '5px 11px', borderRadius: 7,
  cursor: 'pointer', whiteSpace: 'nowrap',
};
export const dieStyle: React.CSSProperties = {
  width: 34, height: 34, borderRadius: 7, background: '#e8e9ee', color: '#1b1d24',
  display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 16,
};

/** Backdrop + panel for the browse overlays (discard / inspect / pickers). */
export const backdrop: React.CSSProperties = {
  position: 'absolute', inset: 0, background: 'rgba(8,10,16,0.62)', zIndex: 60, display: 'grid', placeItems: 'center',
};
export const panel: React.CSSProperties = {
  background: T.pageBg, border: `1px solid oklch(0.4 0.02 260)`, borderRadius: 14, padding: 18,
  boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 10, boxShadow: '0 24px 60px rgba(0,0,0,0.5)',
};
export const closeButton: React.CSSProperties = {
  fontSize: 11, color: T.muted, cursor: 'pointer', border: `1px solid ${T.border}`, borderRadius: 6, padding: '3px 10px',
};
