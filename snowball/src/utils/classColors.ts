/**
 * Canonical accent color per hero class, used for the party-leader dot
 * indicators (and anywhere else a class needs a consistent swatch). Colors echo
 * the printed card classes so players can read a party at a glance.
 */
const CLASS_COLORS: Record<string, string> = {
  bard: '#c5642a',
  berserker: '#e18333',
  fighter: '#9d3b34',
  guardian: '#eab411',
  necromancer: '#d41b69',
  ranger: '#316b35',
  thief: '#215c79',
  wizard: '#733b86',
};

const UNKNOWN_CLASS_COLOR = '#adb5bd';

/** The eight hero classes, in canonical display order. */
export const HERO_CLASSES = [
  'bard',
  'berserker',
  'fighter',
  'guardian',
  'necromancer',
  'ranger',
  'thief',
  'wizard',
] as const;

export const getClassColor = (cardClass?: string): string =>
  (cardClass ? CLASS_COLORS[cardClass.toLowerCase()] : undefined) ?? UNKNOWN_CLASS_COLOR;
