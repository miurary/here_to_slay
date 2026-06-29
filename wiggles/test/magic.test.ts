import { describe, it, expect, beforeEach } from 'vitest';
import { processMagicCardSteps } from '../src/magic.js';
import { handlePromptResponse, handleMultiPromptResponse } from '../src/promptResponse.js';
import {
  createHarness, resetEngineState, buildGameState, buildPlayer, makeCard,
  type Harness,
} from './harness.js';
import type { GameState, Effect } from '../../shared/src/types.js';

beforeEach(() => resetEngineState());

/** Play a magic card by resolving its template's ON_PLAY steps (mirrors the playMagic handler). */
const playMagic = (h: Harness, gs: GameState, casterId: string, templateId: string): string => {
  const tmpl = gs.cardTemplates[templateId]!;
  const steps: Effect[] = tmpl.effect?.steps ?? [tmpl.effect as unknown as Effect];
  const magicCardId = `${templateId}#magic`;
  processMagicCardSteps(h.socket(casterId) as never, gs, gs.players[casterId]!, magicCardId, steps, undefined, true);
  return magicCardId;
};

const respond = (h: Harness, responderId: string, optionId: string) => {
  const prompt = h.socket(responderId).lastPrompt();
  handlePromptResponse(h.socket(responderId) as never, prompt.promptId, optionId, h.sendRoomUpdate);
};

const respondMulti = (h: Harness, responderId: string, optionIds: string[]) => {
  const prompt = h.socket(responderId).lastPrompt();
  handleMultiPromptResponse(h.socket(responderId) as never, prompt.promptId, optionIds, h.sendRoomUpdate);
};

describe('magic cards — ON_PLAY effect resolution', () => {
  it('s_001 Destructive Spell: discard a card, then destroy a hero', () => {
    const discardCard = makeCard('s_002');
    const victim = makeCard('h_043');
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', hand: [discardCard] }), buildPlayer({ id: 'p2', party: [victim] })],
    });
    const h = createHarness(gs);
    playMagic(h, gs, 'p1', 's_001');
    respond(h, 'p1', discardCard.instanceId); // pay the discard
    respond(h, 'p1', victim.instanceId);      // choose the hero to destroy
    expect(gs.discardPile.map(c => c.instanceId)).toContain(discardCard.instanceId);
    expect(gs.players['p2']!.zones.party).toHaveLength(0);
  });

  it('s_002 Enchanted Spell: +2 to all rolls until end of turn', () => {
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1' }), buildPlayer({ id: 'p2' })] });
    const h = createHarness(gs);
    playMagic(h, gs, 'p1', 's_002');
    expect(gs.players['p1']!.temporaryModifiers).toContainEqual({ modifierType: 'rollBonus', amount: 2, duration: 1 });
  });

  it('s_003 Forced Exchange: steal an opponent hero, then give one of yours back', () => {
    const ownHero = makeCard('h_006');
    const oppHero = makeCard('h_043');
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', party: [ownHero] }), buildPlayer({ id: 'p2', party: [oppHero] })],
    });
    const h = createHarness(gs);
    playMagic(h, gs, 'p1', 's_003');
    respond(h, 'p1', oppHero.instanceId); // steal opponent hero
    respond(h, 'p1', ownHero.instanceId); // give one of mine to them
    expect(gs.players['p1']!.zones.party.map(c => c.instanceId)).toEqual([oppHero.instanceId]);
    expect(gs.players['p2']!.zones.party.map(c => c.instanceId)).toContain(ownHero.instanceId);
  });

  it('s_004 Critical Boost: draw 3 then discard 1 (net +2)', () => {
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1' }), buildPlayer({ id: 'p2' })],
      mainDeck: [makeCard('s_001'), makeCard('s_002'), makeCard('s_005')],
    });
    const h = createHarness(gs);
    playMagic(h, gs, 'p1', 's_004');
    expect(gs.players['p1']!.zones.hand).toHaveLength(3);
    respond(h, 'p1', gs.players['p1']!.zones.hand[0]!.instanceId);
    expect(gs.players['p1']!.zones.hand).toHaveLength(2);
  });

  it('s_005 Entangling Trap: discard 2 cards, then steal a hero', () => {
    const a = makeCard('s_001'); const b = makeCard('s_002');
    const victim = makeCard('h_043');
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', hand: [a, b] }), buildPlayer({ id: 'p2', party: [victim] })],
    });
    const h = createHarness(gs);
    playMagic(h, gs, 'p1', 's_005');
    respond(h, 'p1', a.instanceId);
    respond(h, 'p1', b.instanceId);
    respond(h, 'p1', victim.instanceId);
    expect(gs.discardPile.map(c => c.instanceId)).toEqual(expect.arrayContaining([a.instanceId, b.instanceId]));
    expect(gs.players['p1']!.zones.party.map(c => c.instanceId)).toContain(victim.instanceId);
  });

  it('s_006 Mass Sacrifice: discard your whole hand, then draw 5', () => {
    const hand = [makeCard('s_001'), makeCard('s_002'), makeCard('s_003')];
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', hand }), buildPlayer({ id: 'p2' })],
      mainDeck: Array.from({ length: 6 }, (_, i) => makeCard(`s_00${i + 1}`)),
    });
    const h = createHarness(gs);
    playMagic(h, gs, 'p1', 's_006');
    expect(gs.players['p1']!.zones.hand).toHaveLength(5);
    expect(gs.discardPile.map(c => c.instanceId)).toEqual(expect.arrayContaining(hand.map(c => c.instanceId)));
  });

  it('s_007 Call to the Fallen: recover a Hero card from the discard pile', () => {
    const hero = makeCard('h_043');
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1' }), buildPlayer({ id: 'p2' })],
      discardPile: [hero, makeCard('s_001')],
    });
    const h = createHarness(gs);
    playMagic(h, gs, 'p1', 's_007');
    respond(h, 'p1', hero.instanceId);
    expect(gs.players['p1']!.zones.hand.map(c => c.instanceId)).toContain(hero.instanceId);
    expect(gs.discardPile.map(c => c.instanceId)).not.toContain(hero.instanceId);
  });

  it('s_008 Winds of Change: return an equipped item to its owner, then draw', () => {
    const item = makeCard('i_001');
    const wearer = makeCard('h_043', { equippedItem: item.instanceId });
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1' }), buildPlayer({ id: 'p2', party: [wearer, item] })],
      mainDeck: [makeCard('s_001')],
    });
    const h = createHarness(gs);
    playMagic(h, gs, 'p1', 's_008');
    respond(h, 'p1', item.instanceId);
    expect(gs.players['p2']!.zones.hand.map(c => c.instanceId)).toContain(item.instanceId);
    expect(wearer.equippedItem).toBeUndefined();
    expect(gs.players['p1']!.zones.hand).toHaveLength(1); // drew a card
  });

  it('s_009 Lightning Labrys: discard cards, each forcing a hero sacrifice', () => {
    const a = makeCard('s_001');
    const victim = makeCard('h_043');
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', hand: [a] }), buildPlayer({ id: 'p2', party: [victim] })],
    });
    const h = createHarness(gs);
    playMagic(h, gs, 'p1', 's_009');
    respondMulti(h, 'p1', [a.instanceId]); // discard 1 → 1 forced sacrifice
    respond(h, 'p1', victim.instanceId);   // designate the hero to sacrifice
    expect(gs.discardPile.map(c => c.instanceId)).toContain(a.instanceId);
    expect(gs.players['p2']!.zones.party).toHaveLength(0);
  });

  it('s_010 Forceful Winds: return every equipped item to its owner', () => {
    const item1 = makeCard('i_001');
    const wearer1 = makeCard('h_043', { equippedItem: item1.instanceId });
    const item2 = makeCard('i_002');
    const wearer2 = makeCard('h_006', { equippedItem: item2.instanceId });
    const gs = buildGameState({
      players: [
        buildPlayer({ id: 'p1', party: [wearer1, item1] }),
        buildPlayer({ id: 'p2', party: [wearer2, item2] }),
      ],
    });
    const h = createHarness(gs);
    playMagic(h, gs, 'p1', 's_010');
    expect(gs.players['p1']!.zones.hand.map(c => c.instanceId)).toContain(item1.instanceId);
    expect(gs.players['p2']!.zones.hand.map(c => c.instanceId)).toContain(item2.instanceId);
    expect(wearer1.equippedItem).toBeUndefined();
    expect(wearer2.equippedItem).toBeUndefined();
  });
});
