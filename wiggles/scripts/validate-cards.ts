/**
 * Card definition validator.
 *
 * Run with:  npm run validate-cards   (from the wiggles/ directory)
 *
 * Catches the mistakes that break cards at runtime *before* they hit the game:
 *   - structural problems (missing id/name/type, id not matching its JSON key,
 *     duplicate ids, unknown card type)
 *   - ability `action`s the engine does not implement (these silently fall through
 *     to "Unsupported ..." at runtime, so the card does nothing)
 *
 * When you teach the engine a new action, add it to SUPPORTED_ACTIONS below.
 */
import { readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cardsDir = join(__dirname, '..', 'src', 'cards');

// Card `type` values the engine knows how to map (see mapTemplateType in server.ts).
const KNOWN_TYPES = new Set([
  'hero', 'item', 'cursed_item', 'magic', 'modifier',
  'challenge', 'monster', 'party_leader', 'partyleader',
]);

// Effect `action` values the engine actually resolves. Keep in sync with the
// action handling in server.ts. (Derived from the effect/trigger resolvers.)
const SUPPORTED_ACTIONS = new Set([
  'APPLY_PLAYER_MODIFIER', 'APPLY_ROLL_MODIFIER', 'APPLY_ROOM_FLAG', 'CHALLENGE_ROLLS',
  'DESTROY_HERO', 'DISCARD', 'DRAW', 'EXTRA_AP', 'FORCE_END_TURN', 'HAS_CARD_IN_ZONE',
  'HERO_ABILITY_ROLLS', 'ITEM_COIN_DISCARD', 'ITEM_GOBLET_CONFIRM', 'ITEM_SACRIFICE_HERO',
  'MODIFY_ROLL', 'MONSTER_DISCARD', 'MONSTER_SACRIFICE_HERO', 'MOVE_CARD', 'ON_ATTACK_ROLL',
  'ON_CHALLENGE', 'ON_PLAY_MAGIC', 'ON_HERO_ABILITY_ROLL', 'ON_HERO_ROLL_ATTEMPT',
  'ON_HERO_ROLL_FAIL', 'ON_HERO_ROLL_SUCCESS', 'ON_MODIFIER_PLAYED', 'ON_SLAY',
  'PERSISTENT_MODIFIER', 'PLAY_FROM_HAND', 'PROMPT_DISCARD', 'PROMPT_SACRIFICE',
  'PROMPT_SACRIFICE_HERO', 'REROLL_HERO_ABILITY', 'SACRIFICE', 'SLAY', 'STEAL',
  'STEAL_CARD', 'STEAL_RANDOM_CARD', 'SWAP', 'VIEW_HAND',
  // Reactive-passive + cost mechanics (i_004, m_001, m_005)
  'DISCARD_CARDS', 'PROMPT_SELECT', 'DRAW_CARD',
  // Party leader active abilities
  'SEARCH_DISCARD',
  // Slain-monster reactive passives (m_006–m_017)
  'PLAY_DRAWN_CARD', 'FORCE_CHALLENGER_DISCARD', 'STEAL_INSTEAD_OF_DESTROY',
  // Modifier side-effects (mod_007)
  'DISCARD_HAND',
  // Magic card effects (s_005–s_010)
  'RECOVER_HERO', 'RETURN_ITEM', 'RETURN_ALL_ITEMS', 'DISCARD_FOR_SACRIFICE', 'SACRIFICE_ANY_HERO',
  // Hero abilities (h_017–h_065)
  'RECOVER_AND_PLAY', 'TAKE_FROM_HAND', 'GIVE_OR_RECOVER', 'STEAL_HERO', 'DRAW_AND_CHECK',
  'PULL_RANDOM', 'MULTI_SELECT_CHAIN', 'RETURN_CURSED_ITEM', 'NOOP', 'GIVE_CARD',
  'TRADE_HANDS', 'DRAW_TO_HAND_SIZE', 'PEEK_TOP_DECK', 'RETURN_CLASS_TO_HAND',
]);

// Tokens that LOOK like actions but are intentionally not resolved by the action
// switch — the behaviour is driven another way (e.g. challenge cards are handled
// by card type; the goblet's sacrifice happens inside ITEM_GOBLET_CONFIRM). These
// are allowed so the validator doesn't cry wolf over working cards.
const COSMETIC_ACTIONS = new Set([
  'INITIATE_CHALLENGE', // challenge flow is type-driven; this string is descriptive
  'DISCARD_SELF',       // discarding the played challenge card is handled by playChallenge
  'SACRIFICE_SELF',     // goblet sacrifice is handled inside ITEM_GOBLET_CONFIRM
]);

interface Issue { level: 'ERROR' | 'WARN'; file: string; card: string; msg: string; }

const issues: Issue[] = [];
const seenIds = new Map<string, string>(); // id -> file (for duplicate detection)

/** Recursively collect every value under an "action" key. */
function collectActions(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectActions(item, out);
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'action' && typeof value === 'string') out.add(value);
      collectActions(value, out);
    }
  }
}

const files = readdirSync(cardsDir).filter((f) => f.endsWith('.json'));

for (const file of files) {
  let json: Record<string, Record<string, unknown>>;
  try {
    json = JSON.parse(readFileSync(join(cardsDir, file), 'utf8'));
  } catch (err) {
    issues.push({ level: 'ERROR', file, card: '(file)', msg: `invalid JSON: ${(err as Error).message}` });
    continue;
  }

  for (const [key, card] of Object.entries(json)) {
    const id = card.id as string | undefined;
    const name = card.name as string | undefined;
    const type = card.type as string | undefined;
    const label = id ?? key;

    if (!id) issues.push({ level: 'ERROR', file, card: key, msg: 'missing "id"' });
    else if (id !== key) issues.push({ level: 'ERROR', file, card: key, msg: `"id" ("${id}") does not match its JSON key ("${key}") — in-game lookups key off id` });

    if (id) {
      const prior = seenIds.get(id);
      if (prior) issues.push({ level: 'ERROR', file, card: label, msg: `duplicate id also defined in ${prior}` });
      else seenIds.set(id, file);
    }

    if (!name) issues.push({ level: 'WARN', file, card: label, msg: 'missing "name" (UI will show the id)' });

    if (!type) issues.push({ level: 'ERROR', file, card: label, msg: 'missing "type"' });
    else if (!KNOWN_TYPES.has(type.toLowerCase())) issues.push({ level: 'ERROR', file, card: label, msg: `unknown type "${type}"` });

    const actions = new Set<string>();
    collectActions(card, actions);
    for (const action of actions) {
      if (SUPPORTED_ACTIONS.has(action) || COSMETIC_ACTIONS.has(action)) continue;
      issues.push({ level: 'ERROR', file, card: label, msg: `action "${action}" is not implemented by the engine — card will silently do nothing` });
    }
  }
}

// ── Report ────────────────────────────────────────────────────────────────────
const errors = issues.filter((i) => i.level === 'ERROR');
const warns = issues.filter((i) => i.level === 'WARN');
const total = seenIds.size;

for (const i of issues) {
  const tag = i.level === 'ERROR' ? '✗ ERROR' : '⚠ WARN ';
  console.log(`${tag}  ${i.file} › ${i.card}: ${i.msg}`);
}

console.log(`\nChecked ${total} cards across ${files.length} files — ${errors.length} error(s), ${warns.length} warning(s).`);
process.exit(errors.length > 0 ? 1 : 0);
