import { describe, it, expect, beforeEach } from 'vitest';
import { activateHeroAbility } from '../src/effects.js';
import { handlePromptResponse, handleMultiPromptResponse } from '../src/promptResponse.js';
import {
  createHarness, resetEngineState, buildGameState, buildPlayer, makeCard, makeMonster,
  type Harness,
} from './harness.js';
import type { GameState, PlayerState } from '../../shared/src/types.js';

beforeEach(() => resetEngineState());

/** Activate the active skill of `heroId` (must be in `casterId`'s party). */
const activate = (h: Harness, gs: GameState, casterId: string, heroId: string) =>
  activateHeroAbility(h.socket(casterId) as never, gs, heroId, h.sendRoomUpdate);

/** Answer the most recent prompt that `responderId` received. */
const respond = (h: Harness, gs: GameState, responderId: string, optionId: string) => {
  const prompt = h.socket(responderId).lastPrompt();
  handlePromptResponse(h.socket(responderId) as never, prompt.promptId, optionId, h.sendRoomUpdate);
};

/** Answer the most recent multi-select prompt that `responderId` received. */
const respondMulti = (h: Harness, gs: GameState, responderId: string, optionIds: string[]) => {
  const prompt = h.socket(responderId).lastPrompt();
  handleMultiPromptResponse(h.socket(responderId) as never, prompt.promptId, optionIds, h.sendRoomUpdate);
};

const findHero = (p: PlayerState, templateId: string) =>
  p.zones.party.find(c => c.templateId === templateId)!;

describe('hero active skills — effect resolution', () => {
  it('h_043 Peanut: DRAW 2 puts two main-deck cards into the caster hand', () => {
    const peanut = makeCard('h_043');
    const caster = buildPlayer({ id: 'p1', party: [peanut] });
    const gs = buildGameState({
      players: [caster, buildPlayer({ id: 'p2' })],
      mainDeck: [makeCard('s_001'), makeCard('s_002'), makeCard('s_003')],
    });
    const h = createHarness(gs);

    activate(h, gs, 'p1', peanut.instanceId);

    expect(gs.players['p1']!.zones.hand).toHaveLength(2);
    expect(gs.mainDeck).toHaveLength(1);
    expect(peanut.effectUsedThisTurn).toBe(true);
    expect(h.socket('p1').prompts()).toHaveLength(0); // no prompt for a plain DRAW
  });

  it('h_045 Napping Nibbles: NOOP changes no zones but consumes the ability', () => {
    const nibbles = makeCard('h_045');
    const caster = buildPlayer({ id: 'p1', party: [nibbles], hand: [makeCard('s_001')] });
    const gs = buildGameState({ players: [caster, buildPlayer({ id: 'p2' })] });
    const h = createHarness(gs);

    activate(h, gs, 'p1', nibbles.instanceId);

    expect(gs.players['p1']!.zones.hand).toHaveLength(1);
    expect(gs.discardPile).toHaveLength(0);
    expect(nibbles.effectUsedThisTurn).toBe(true);
  });

  it('h_027 Bad Axe: DESTROY_HERO prompts the caster, then discards the chosen opponent hero', () => {
    const badAxe = makeCard('h_027');
    const victim = makeCard('h_043'); // a plain hero in the opponent party
    const caster = buildPlayer({ id: 'p1', party: [badAxe] });
    const opponent = buildPlayer({ id: 'p2', party: [victim] });
    const gs = buildGameState({ players: [caster, opponent] });
    const h = createHarness(gs);

    activate(h, gs, 'p1', badAxe.instanceId);

    const prompt = h.socket('p1').lastPrompt();
    expect(prompt.promptType).toBe('selectCard');
    expect(prompt.options.map(o => o.id)).toContain(victim.instanceId);

    respond(h, gs, 'p1', victim.instanceId);

    expect(gs.players['p2']!.zones.party).toHaveLength(0);
    expect(gs.discardPile.map(c => c.instanceId)).toContain(victim.instanceId);
    expect(badAxe.effectUsedThisTurn).toBe(true);
  });

  it('h_065 Serious Grey: chains DESTROY_HERO then DRAW 1 after the prompt resolves', () => {
    const grey = makeCard('h_065');
    const victim = makeCard('h_043');
    const caster = buildPlayer({ id: 'p1', party: [grey] });
    const opponent = buildPlayer({ id: 'p2', party: [victim] });
    const gs = buildGameState({
      players: [caster, opponent],
      mainDeck: [makeCard('s_001'), makeCard('s_002')],
    });
    const h = createHarness(gs);

    activate(h, gs, 'p1', grey.instanceId);
    respond(h, gs, 'p1', victim.instanceId);

    expect(gs.players['p2']!.zones.party).toHaveLength(0);       // destroyed
    expect(gs.players['p1']!.zones.hand).toHaveLength(1);        // then drew 1
    expect(gs.mainDeck).toHaveLength(1);
  });

  it('h_001 Bark Hexer: pays the DISCARD cost, then prompts every opponent to discard 2', () => {
    const hexer = makeCard('h_001');
    const costCard = makeCard('s_001');
    const caster = buildPlayer({ id: 'p1', party: [hexer], hand: [costCard, makeCard('s_002')] });
    const opp1 = buildPlayer({ id: 'p2', hand: [makeCard('s_003'), makeCard('s_004')] });
    const opp2 = buildPlayer({ id: 'p3', hand: [makeCard('s_005'), makeCard('s_006')] });
    const gs = buildGameState({ players: [caster, opp1, opp2] });
    const h = createHarness(gs);

    activate(h, gs, 'p1', hexer.instanceId);

    // First prompt is the caster paying the discard cost.
    const costPrompt = h.socket('p1').lastPrompt();
    expect(costPrompt.promptType).toBe('discardCard');
    respond(h, gs, 'p1', costCard.instanceId);

    // Cost card is discarded from the caster's hand.
    expect(gs.players['p1']!.zones.hand.map(c => c.instanceId)).not.toContain(costCard.instanceId);
    expect(gs.discardPile.map(c => c.instanceId)).toContain(costCard.instanceId);

    // Each opponent is now prompted to discard 2.
    for (const id of ['p2', 'p3']) {
      const p = h.socket(id).lastPrompt();
      expect(p.promptType).toBe('discardCard');
      expect(p.message).toMatch(/2 card/);
    }
  });
});

describe('hero active skills — self modifiers & room flags', () => {
  it('h_006 Vibrant Glow: +5 roll bonus until end of turn (duration 1)', () => {
    const card = makeCard('h_006');
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1', party: [card] }), buildPlayer({ id: 'p2' })] });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    expect(gs.players['p1']!.temporaryModifiers).toContainEqual({ modifierType: 'rollBonus', amount: 5, duration: 1 });
  });

  it('h_033 Wise Shield: +3 roll bonus until end of turn', () => {
    const card = makeCard('h_033');
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1', party: [card] }), buildPlayer({ id: 'p2' })] });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    expect(gs.players['p1']!.temporaryModifiers).toContainEqual({ modifierType: 'rollBonus', amount: 3, duration: 1 });
  });

  it('h_032 Mighty Blade: blockHeroDestruction until next turn (duration 2)', () => {
    const card = makeCard('h_032');
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1', party: [card] }), buildPlayer({ id: 'p2' })] });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    expect(gs.players['p1']!.temporaryModifiers).toContainEqual({ modifierType: 'blockHeroDestruction', amount: 0, duration: 2 });
  });

  it('h_034 Calming Voice: blockSteal until next turn (duration 2)', () => {
    const card = makeCard('h_034');
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1', party: [card] }), buildPlayer({ id: 'p2' })] });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    expect(gs.players['p1']!.temporaryModifiers).toContainEqual({ modifierType: 'blockSteal', amount: 0, duration: 2 });
  });

  it('h_030 Iron Resolve: sets the blockAllChallenges room flag', () => {
    const card = makeCard('h_030');
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1', party: [card] }), buildPlayer({ id: 'p2' })] });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    expect(gs.roomFlags?.blockAllChallenges).toBe(true);
  });

  it('h_004 Meowntain: SACRIFICE cost then +5 roll bonus', () => {
    const card = makeCard('h_004');
    const fodder = makeCard('h_043');
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1', party: [card, fodder] }), buildPlayer({ id: 'p2' })] });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    respond(h, gs, 'p1', fodder.instanceId); // pay sacrifice cost
    expect(gs.discardPile.map(c => c.instanceId)).toContain(fodder.instanceId);
    expect(gs.players['p1']!.temporaryModifiers).toContainEqual({ modifierType: 'rollBonus', amount: 5, duration: 1 });
  });

  it('h_002 Shadow Saint: DISCARD a Modifier cost then locks opponent modifiers', () => {
    const card = makeCard('h_002');
    const mod = makeCard('mod_001'); // a modifier card
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1', party: [card], hand: [mod] }), buildPlayer({ id: 'p2' })] });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    respond(h, gs, 'p1', mod.instanceId);
    expect(gs.discardPile.map(c => c.instanceId)).toContain(mod.instanceId);
    expect(gs.roomFlags?.lockModifiers).toBe(true);
  });
});

describe('hero active skills — discard-pile search (MOVE_CARD)', () => {
  const cases: Array<[hero: string, target: string]> = [
    ['h_005', 'mod_001'], // Radiant Horn — Modifier
    ['h_009', 'i_001'],   // Lookie Rookie — Item
    ['h_015', 's_001'],   // Bun Bun — Magic
    ['h_029', 'h_043'],   // Guiding Light — Hero
    ['h_056', 'chal_001'],// Annihilator — Challenge
  ];
  for (const [hero, target] of cases) {
    it(`${hero}: pulls the chosen card from the discard pile into hand`, () => {
      const card = makeCard(hero);
      const wanted = makeCard(target);
      const gs = buildGameState({
        players: [buildPlayer({ id: 'p1', party: [card] }), buildPlayer({ id: 'p2' })],
        discardPile: [wanted, makeCard('s_002')],
      });
      const h = createHarness(gs);
      activate(h, gs, 'p1', card.instanceId);
      respond(h, gs, 'p1', wanted.instanceId);
      expect(gs.players['p1']!.zones.hand.map(c => c.instanceId)).toContain(wanted.instanceId);
      expect(gs.discardPile.map(c => c.instanceId)).not.toContain(wanted.instanceId);
    });
  }

  // Regression guard: the targetRequirement fix restores the cardType filter, so Radiant
  // Horn only offers Modifier cards from the discard pile.
  it('h_005 Radiant Horn: only Modifier cards should be offered from the discard pile', () => {
    const card = makeCard('h_005');
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', party: [card] }), buildPlayer({ id: 'p2' })],
      discardPile: [makeCard('s_001'), makeCard('h_043'), makeCard('mod_001')],
    });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    const offered = h.socket('p1').lastPrompt().options.map(o => o.payload?.cardInstanceId);
    // Intended: exactly one option (the modifier). Currently all three are offered.
    expect(offered).toHaveLength(1);
  });
});

describe('hero active skills — destroy variants', () => {
  it('h_038 Fluffy: DESTROY 2 hero cards via two sequential prompts', () => {
    const card = makeCard('h_038');
    const v1 = makeCard('h_043');
    const v2 = makeCard('h_006');
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', party: [card] }), buildPlayer({ id: 'p2', party: [v1, v2] })],
    });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    respond(h, gs, 'p1', v1.instanceId);
    respond(h, gs, 'p1', v2.instanceId);
    expect(gs.players['p2']!.zones.party).toHaveLength(0);
    expect(gs.discardPile).toHaveLength(2);
  });

  it('h_050 Shurikitty: destroyed hero\'s equipped item goes to the caster\'s hand', () => {
    const card = makeCard('h_050');
    const item = makeCard('i_001');
    const victim = makeCard('h_043', { equippedItem: item.instanceId });
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', party: [card] }), buildPlayer({ id: 'p2', party: [victim, item] })],
    });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    respond(h, gs, 'p1', victim.instanceId);
    expect(gs.players['p1']!.zones.hand.map(c => c.instanceId)).toContain(item.instanceId);
    expect(gs.discardPile.map(c => c.instanceId)).toContain(victim.instanceId);
    expect(gs.discardPile.map(c => c.instanceId)).not.toContain(item.instanceId);
  });

  it('h_054 Unbridled Fury: destroying a Berserker grants +1 action point', () => {
    const card = makeCard('h_054');
    const berserker = makeCard('h_003'); // Vicious Wildcat is a berserker
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', party: [card], actionPoints: 1 }), buildPlayer({ id: 'p2', party: [berserker] })],
    });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    respond(h, gs, 'p1', berserker.instanceId);
    expect(gs.players['p1']!.actionPoints).toBe(2);
  });
});

describe('hero active skills — steal hero variants', () => {
  it('h_049 Kit Napper: STEAL a hero into the caster\'s party', () => {
    const card = makeCard('h_049');
    const target = makeCard('h_043');
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', party: [card] }), buildPlayer({ id: 'p2', party: [target] })],
    });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    respond(h, gs, 'p1', target.instanceId);
    expect(gs.players['p1']!.zones.party.map(c => c.instanceId)).toContain(target.instanceId);
    expect(gs.players['p2']!.zones.party).toHaveLength(0);
  });

  it('h_022 Perfect Vessel: steals a hero, then sacrifices itself', () => {
    const card = makeCard('h_022');
    const target = makeCard('h_043');
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', party: [card] }), buildPlayer({ id: 'p2', party: [target] })],
    });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    respond(h, gs, 'p1', target.instanceId);
    const p1party = gs.players['p1']!.zones.party.map(c => c.instanceId);
    expect(p1party).toContain(target.instanceId);
    expect(p1party).not.toContain(card.instanceId);            // sacrificed self
    expect(gs.discardPile.map(c => c.instanceId)).toContain(card.instanceId);
  });

  it('h_041 Tipsy Tootie: steals a hero, then joins the robbed player\'s party', () => {
    const card = makeCard('h_041');
    const target = makeCard('h_043');
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', party: [card] }), buildPlayer({ id: 'p2', party: [target] })],
    });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    respond(h, gs, 'p1', target.instanceId);
    expect(gs.players['p1']!.zones.party.map(c => c.instanceId)).toContain(target.instanceId);
    expect(gs.players['p2']!.zones.party.map(c => c.instanceId)).toContain(card.instanceId);
  });
});

describe('hero active skills — pull from hand (PULL_RANDOM)', () => {
  it('h_024 Bear Claw: a pulled Hero grants a second pull', () => {
    const card = makeCard('h_024');
    const gs = buildGameState({
      players: [
        buildPlayer({ id: 'p1', party: [card] }),
        buildPlayer({ id: 'p2', hand: [makeCard('h_043'), makeCard('h_006')] }), // both heroes
      ],
    });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    respond(h, gs, 'p1', 'p2'); // choose player to pull from
    expect(gs.players['p1']!.zones.hand).toHaveLength(2); // base pull + hero-bonus pull
    expect(gs.players['p2']!.zones.hand).toHaveLength(0);
  });

  it('h_048 Slippery Paws: pulls 2 cards then discards one of them', () => {
    const card = makeCard('h_048');
    const a = makeCard('s_001'); const b = makeCard('s_002');
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', party: [card] }), buildPlayer({ id: 'p2', hand: [a, b] })],
    });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    respond(h, gs, 'p1', 'p2');
    expect(gs.players['p1']!.zones.hand).toHaveLength(2); // both pulled
    const discardPrompt = h.socket('p1').lastPrompt();
    expect(discardPrompt.promptType).toBe('discardCard');
    respond(h, gs, 'p1', a.instanceId);
    expect(gs.players['p1']!.zones.hand).toHaveLength(1);
    expect(gs.discardPile.map(c => c.instanceId)).toContain(a.instanceId);
  });

  it('h_053 Plundering Puma: pulls 2 and offers the robbed player a draw', () => {
    const card = makeCard('h_053');
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', party: [card] }), buildPlayer({ id: 'p2', hand: [makeCard('s_001'), makeCard('s_002')] })],
    });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    respond(h, gs, 'p1', 'p2');
    expect(gs.players['p1']!.zones.hand).toHaveLength(2);
    expect(h.socket('p2').lastPrompt().promptType).toBe('confirm'); // may-draw offer
  });

  it('h_037 Buttons: a pulled Magic card may be played immediately', () => {
    const card = makeCard('h_037');
    const magic = makeCard('s_002');
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', party: [card] }), buildPlayer({ id: 'p2', hand: [magic] })],
    });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    respond(h, gs, 'p1', 'p2');
    expect(gs.players['p1']!.zones.hand.map(c => c.instanceId)).toContain(magic.instanceId);
    expect(h.socket('p1').lastPrompt().promptType).toBe('confirm'); // play-it-now offer
  });
});

describe('hero active skills — take from hand (TAKE_FROM_HAND)', () => {
  it('h_052 Silent Shadow: look at a hand and take a chosen card', () => {
    const card = makeCard('h_052');
    const wanted = makeCard('s_001');
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', party: [card] }), buildPlayer({ id: 'p2', hand: [wanted] })],
    });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    respond(h, gs, 'p1', 'p2');             // pick the player
    respond(h, gs, 'p1', wanted.instanceId); // pick the card
    expect(gs.players['p1']!.zones.hand.map(c => c.instanceId)).toContain(wanted.instanceId);
    expect(gs.players['p2']!.zones.hand).toHaveLength(0);
  });

  it('h_059 Gruesome Gladiator: take a card from every opponent hand', () => {
    const card = makeCard('h_059');
    const a = makeCard('s_001'); const b = makeCard('s_002');
    const gs = buildGameState({
      players: [
        buildPlayer({ id: 'p1', party: [card] }),
        buildPlayer({ id: 'p2', hand: [a] }),
        buildPlayer({ id: 'p3', hand: [b] }),
      ],
    });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    // Two selectCard prompts queued on the caster, one per opponent.
    for (const p of [...h.socket('p1').prompts()]) {
      handlePromptResponse(h.socket('p1') as never, p.promptId, p.options[0]!.id, h.sendRoomUpdate);
    }
    expect(gs.players['p1']!.zones.hand).toHaveLength(2);
  });
});

describe('hero active skills — forced sacrifice (PROMPT_SACRIFICE)', () => {
  it('h_016 Spooky: each opponent sacrifices a Hero', () => {
    const card = makeCard('h_016');
    const v2 = makeCard('h_043'); const v3 = makeCard('h_006');
    const gs = buildGameState({
      players: [
        buildPlayer({ id: 'p1', party: [card] }),
        buildPlayer({ id: 'p2', party: [v2] }),
        buildPlayer({ id: 'p3', party: [v3] }),
      ],
    });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    respond(h, gs, 'p2', v2.instanceId);
    respond(h, gs, 'p3', v3.instanceId);
    expect(gs.players['p2']!.zones.party).toHaveLength(0);
    expect(gs.players['p3']!.zones.party).toHaveLength(0);
    expect(gs.discardPile).toHaveLength(2);
  });

  it('h_040 Hopper: a chosen player must sacrifice a Hero', () => {
    const card = makeCard('h_040');
    const victim = makeCard('h_043');
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', party: [card] }), buildPlayer({ id: 'p2', party: [victim] })],
    });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    respond(h, gs, 'p1', 'p2');               // choose the player
    respond(h, gs, 'p2', victim.instanceId);  // that player sacrifices
    expect(gs.players['p2']!.zones.party).toHaveLength(0);
  });

  it('h_058 Brawling Spirit: only players with >3 party cards must sacrifice', () => {
    const card = makeCard('h_058');
    const bigParty = [makeCard('h_043'), makeCard('h_006'), makeCard('h_033'), makeCard('h_027')];
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', party: [card] }), buildPlayer({ id: 'p2', party: bigParty })],
    });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    // p1 has only 1 party card → not affected; p2 has 4 → prompted.
    expect(h.socket('p2').prompts().length).toBeGreaterThan(0);
    respond(h, gs, 'p2', bigParty[0]!.instanceId);
    expect(gs.players['p2']!.zones.party).toHaveLength(3);
  });
});

describe('hero active skills — multi-select chains', () => {
  it('h_028 Qi Bear: discard a card to destroy a hero', () => {
    const card = makeCard('h_028');
    const fodder = makeCard('s_001');
    const victim = makeCard('h_043');
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', party: [card], hand: [fodder] }), buildPlayer({ id: 'p2', party: [victim] })],
    });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    respondMulti(h, gs, 'p1', [fodder.instanceId]); // discard 1 → 1 destroy follow-up
    respond(h, gs, 'p1', victim.instanceId);
    expect(gs.discardPile.map(c => c.instanceId)).toContain(fodder.instanceId);
    expect(gs.players['p2']!.zones.party).toHaveLength(0);
  });

  it('h_055 Rabid Beast: sacrifice a card to destroy a hero', () => {
    const card = makeCard('h_055');
    const fodder = makeCard('h_006');
    const victim = makeCard('h_043');
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', party: [card, fodder] }), buildPlayer({ id: 'p2', party: [victim] })],
    });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    respondMulti(h, gs, 'p1', [fodder.instanceId]); // sacrifice 1 → 1 destroy follow-up
    respond(h, gs, 'p1', victim.instanceId);
    expect(gs.discardPile.map(c => c.instanceId)).toContain(fodder.instanceId);
    expect(gs.players['p2']!.zones.party).toHaveLength(0);
  });
});

describe('hero active skills — draw & check', () => {
  it('h_047 Mellow Dee: drawn Hero may be played immediately', () => {
    const card = makeCard('h_047');
    const top = makeCard('h_043');
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', party: [card] }), buildPlayer({ id: 'p2' })],
      mainDeck: [top],
    });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    respond(h, gs, 'p1', top.instanceId); // play the drawn hero
    expect(gs.players['p1']!.zones.party.map(c => c.instanceId)).toContain(top.instanceId);
  });

  it('h_060 Quick Draw: draws 2 and offers to play a drawn Item (skip keeps it)', () => {
    const card = makeCard('h_060');
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', party: [card] }), buildPlayer({ id: 'p2' })],
      mainDeck: [makeCard('i_001'), makeCard('s_001')],
    });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    expect(gs.players['p1']!.zones.hand).toHaveLength(2);
    respond(h, gs, 'p1', 'skip');
    expect(gs.players['p1']!.zones.hand).toHaveLength(2);
  });

  it('h_036 Snowball: drawn Magic is played immediately, then draw a bonus card', () => {
    const card = makeCard('h_036');
    const spell = makeCard('s_002'); // Enchanted Spell: +2 to rolls
    const bonus = makeCard('s_003');
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', party: [card] }), buildPlayer({ id: 'p2' })],
      mainDeck: [spell, bonus],
    });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    respond(h, gs, 'p1', spell.instanceId); // play the drawn magic
    expect(gs.players['p1']!.temporaryModifiers).toContainEqual({ modifierType: 'rollBonus', amount: 2, duration: 1 });
    expect(gs.players['p1']!.zones.hand.map(c => c.instanceId)).toContain(bonus.instanceId);
  });

  it('h_023 Pan Chucks: a drawn Challenge may be revealed to destroy a hero', () => {
    const card = makeCard('h_023');
    const victim = makeCard('h_043');
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', party: [card] }), buildPlayer({ id: 'p2', party: [victim] })],
      mainDeck: [makeCard('chal_001'), makeCard('s_001')],
    });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    respond(h, gs, 'p1', 'yes');               // reveal & destroy
    respond(h, gs, 'p1', victim.instanceId);   // choose the hero
    expect(gs.players['p2']!.zones.party).toHaveLength(0);
  });
});

describe('hero active skills — chained steal/move', () => {
  // Regression guard for the targetRequirement-nesting fix (effects.ts): MOVE_CARD now
  // reads template.activeSkill.targetRequirement, so Meowzio's opponent-steal branch works.
  it('h_012 Meowzio: steal a hero AND pull a card from that player', () => {
    const card = makeCard('h_012');
    const hero = makeCard('h_043');
    const handCard = makeCard('s_001');
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', party: [card] }), buildPlayer({ id: 'p2', party: [hero], hand: [handCard] })],
    });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    respond(h, gs, 'p1', hero.instanceId); // steal the hero (carries playerId p2)
    expect(gs.players['p1']!.zones.party.map(c => c.instanceId)).toContain(hero.instanceId);
    expect(gs.players['p1']!.zones.hand.map(c => c.instanceId)).toContain(handCard.instanceId);
  });

  it('h_039 Whiskers: steal a hero, then destroy a hero', () => {
    const card = makeCard('h_039');
    const steal = makeCard('h_043');
    const destroy = makeCard('h_006');
    const gs = buildGameState({
      players: [
        buildPlayer({ id: 'p1', party: [card] }),
        buildPlayer({ id: 'p2', party: [steal] }),
        buildPlayer({ id: 'p3', party: [destroy] }),
      ],
    });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    respond(h, gs, 'p1', steal.instanceId);   // steal from p2
    respond(h, gs, 'p1', destroy.instanceId); // destroy p3's hero
    expect(gs.players['p1']!.zones.party.map(c => c.instanceId)).toContain(steal.instanceId);
    expect(gs.players['p3']!.zones.party).toHaveLength(0);
  });

  it('h_035 Wiggles: steal a hero and roll its effect immediately', () => {
    const card = makeCard('h_035');
    const hero = makeCard('h_043');
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', party: [card] }), buildPlayer({ id: 'p2', party: [hero] })],
    });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    respond(h, gs, 'p1', hero.instanceId);
    expect(gs.players['p1']!.zones.party.map(c => c.instanceId)).toContain(hero.instanceId);
    expect(h.socket('p1').emittedOf('heroRollResult').length).toBeGreaterThan(0);
  });
});

describe('hero active skills — recover & play (with sacrifice cost)', () => {
  it('h_018 Beholden Retriever: sacrifice a Hero, recover & play a Hero from discard', () => {
    const card = makeCard('h_018');
    const fodder = makeCard('h_006');
    const recovered = makeCard('h_033');
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', party: [card, fodder] }), buildPlayer({ id: 'p2' })],
      discardPile: [recovered],
    });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    respond(h, gs, 'p1', fodder.instanceId);    // pay sacrifice cost
    respond(h, gs, 'p1', recovered.instanceId); // recover + play
    expect(gs.players['p1']!.zones.party.map(c => c.instanceId)).toContain(recovered.instanceId);
    expect(gs.discardPile.map(c => c.instanceId)).toContain(fodder.instanceId);
  });

  it('h_021 Bone Collector: sacrifice an Item, recover & play a Hero from discard', () => {
    const card = makeCard('h_021');
    const item = makeCard('i_001');
    const recovered = makeCard('h_033');
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', party: [card, item] }), buildPlayer({ id: 'p2' })],
      discardPile: [recovered],
    });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    respond(h, gs, 'p1', item.instanceId);
    respond(h, gs, 'p1', recovered.instanceId);
    expect(gs.players['p1']!.zones.party.map(c => c.instanceId)).toContain(recovered.instanceId);
  });
});

describe('hero active skills — give / trade / view / conditional', () => {
  it('h_046 Greedy Cheeks: each opponent gives the caster a card', () => {
    const card = makeCard('h_046');
    const a = makeCard('s_001'); const b = makeCard('s_002');
    const gs = buildGameState({
      players: [
        buildPlayer({ id: 'p1', party: [card] }),
        buildPlayer({ id: 'p2', hand: [a] }),
        buildPlayer({ id: 'p3', hand: [b] }),
      ],
    });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    respond(h, gs, 'p2', a.instanceId);
    respond(h, gs, 'p3', b.instanceId);
    expect(gs.players['p1']!.zones.hand).toHaveLength(2);
  });

  it('h_042 Dodgy Dealer: trade hands with a chosen player', () => {
    const card = makeCard('h_042');
    const gs = buildGameState({
      players: [
        buildPlayer({ id: 'p1', party: [card], hand: [makeCard('s_001')] }),
        buildPlayer({ id: 'p2', hand: [makeCard('s_002'), makeCard('s_003')] }),
      ],
    });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    respond(h, gs, 'p1', 'p2');
    expect(gs.players['p1']!.zones.hand).toHaveLength(2);
    expect(gs.players['p2']!.zones.hand).toHaveLength(1);
  });

  it('h_020 Boston Terror: a chosen player gives a card from their hand', () => {
    const card = makeCard('h_020');
    const given = makeCard('s_001');
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', party: [card] }), buildPlayer({ id: 'p2', hand: [given] })],
    });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    respond(h, gs, 'p1', 'p2');             // choose the player
    respond(h, gs, 'p2', given.instanceId); // they give a card
    expect(gs.players['p1']!.zones.hand.map(c => c.instanceId)).toContain(given.instanceId);
  });

  it('h_010 Sharp Fox: view a hand (emits a resolution, no state change)', () => {
    const card = makeCard('h_010');
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', party: [card] }), buildPlayer({ id: 'p2', hand: [makeCard('s_001')] })],
    });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    respond(h, gs, 'p1', 'p2');
    expect(h.socket('p1').emittedOf('abilityResolution').length).toBeGreaterThan(0);
  });

  it('h_007 Tough Teddy: only opponents with a Fighter must discard', () => {
    const card = makeCard('h_007');
    const gs = buildGameState({
      players: [
        buildPlayer({ id: 'p1', party: [card] }),
        buildPlayer({ id: 'p2', party: [makeCard('h_027')], hand: [makeCard('s_001')] }), // has a Fighter
        buildPlayer({ id: 'p3', party: [makeCard('h_043')], hand: [makeCard('s_002')] }), // bard, no Fighter
      ],
    });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    expect(h.socket('p2').prompts().length).toBeGreaterThan(0);
    expect(h.socket('p3').prompts().length).toBe(0);
  });

  it('h_011 Smooth Mimimeow: pulls only from opponents who have a Thief', () => {
    const card = makeCard('h_011');
    const gs = buildGameState({
      players: [
        buildPlayer({ id: 'p1', party: [card] }),
        buildPlayer({ id: 'p2', party: [makeCard('h_049')], hand: [makeCard('s_001')] }), // Kit Napper = thief
        buildPlayer({ id: 'p3', party: [makeCard('h_043')], hand: [makeCard('s_002')] }), // bard
      ],
    });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    expect(gs.players['p1']!.zones.hand).toHaveLength(1);
    expect(gs.players['p2']!.zones.hand).toHaveLength(0);
    expect(gs.players['p3']!.zones.hand).toHaveLength(1); // untouched
  });
});

describe('hero active skills — deck manipulation & remaining specials', () => {
  it('h_062 Wily Red: draws up to a hand size of 7', () => {
    const card = makeCard('h_062');
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', party: [card], hand: [makeCard('s_001'), makeCard('s_002'), makeCard('s_003')] }), buildPlayer({ id: 'p2' })],
      mainDeck: Array.from({ length: 6 }, (_, i) => makeCard(`s_00${i + 1}`)),
    });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    expect(gs.players['p1']!.zones.hand).toHaveLength(7);
  });

  it('h_061 Bullseye: peek top 3, take one into hand', () => {
    const card = makeCard('h_061');
    const top = makeCard('s_001');
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', party: [card] }), buildPlayer({ id: 'p2' })],
      mainDeck: [top, makeCard('s_002'), makeCard('s_003'), makeCard('s_004')],
    });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    respond(h, gs, 'p1', top.instanceId);
    expect(gs.players['p1']!.zones.hand.map(c => c.instanceId)).toContain(top.instanceId);
  });

  it('h_064 Wildshot: draw 3 then discard 1 (net +2)', () => {
    const card = makeCard('h_064');
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', party: [card] }), buildPlayer({ id: 'p2' })],
      mainDeck: [makeCard('s_001'), makeCard('s_002'), makeCard('s_003')],
    });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    const drawn = gs.players['p1']!.zones.hand[0]!;
    respond(h, gs, 'p1', drawn.instanceId);
    expect(gs.players['p1']!.zones.hand).toHaveLength(2);
  });

  it('h_013 Fuzzy Cheeks: draw a card then play a Hero from hand', () => {
    const card = makeCard('h_013');
    const hero = makeCard('h_043');
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', party: [card] }), buildPlayer({ id: 'p2' })],
      mainDeck: [hero],
    });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    respond(h, gs, 'p1', hero.instanceId); // play the drawn hero
    expect(gs.players['p1']!.zones.party.map(c => c.instanceId)).toContain(hero.instanceId);
  });

  it('h_063 Hook: play an Item from hand immediately and draw', () => {
    const card = makeCard('h_063');
    const item = makeCard('i_001');
    const drawn = makeCard('s_001');
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', party: [card], hand: [item] }), buildPlayer({ id: 'p2' })],
      mainDeck: [drawn],
    });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    respond(h, gs, 'p1', item.instanceId); // choose the item to play
    respond(h, gs, 'p1', card.instanceId); // equip it to Hook
    expect(card.equippedItem).toBe(item.instanceId);
    expect(gs.players['p1']!.zones.hand.map(c => c.instanceId)).toContain(drawn.instanceId);
  });

  it('h_031 Holy Curselifter: return an equipped Cursed Item to hand', () => {
    const card = makeCard('h_031');
    const cursed = makeCard('ci_001');
    const wearer = makeCard('h_043', { equippedItem: cursed.instanceId });
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', party: [card, wearer, cursed] }), buildPlayer({ id: 'p2' })],
    });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    respond(h, gs, 'p1', cursed.instanceId);
    expect(gs.players['p1']!.zones.hand.map(c => c.instanceId)).toContain(cursed.instanceId);
    expect(wearer.equippedItem).toBeUndefined();
  });

  it('h_057 Roaryal Guard: return every Hero of a chosen Class to its owner', () => {
    const card = makeCard('h_057');
    const bard = makeCard('h_043'); // Peanut is a bard
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', party: [card] }), buildPlayer({ id: 'p2', party: [bard] })],
    });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    respond(h, gs, 'p1', 'bard');
    expect(gs.players['p2']!.zones.party).toHaveLength(0);
    expect(gs.players['p2']!.zones.hand.map(c => c.instanceId)).toContain(bard.instanceId);
  });

  it('h_017 Grim Pupper: every player (including the caster) sacrifices a card', () => {
    const card = makeCard('h_017');
    const fodder = makeCard('h_006');
    const v2 = makeCard('h_043');
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', party: [card, fodder] }), buildPlayer({ id: 'p2', party: [v2] })],
    });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    respond(h, gs, 'p1', fodder.instanceId);
    respond(h, gs, 'p2', v2.instanceId);
    expect(gs.players['p1']!.zones.party.map(c => c.instanceId)).toEqual([card.instanceId]);
    expect(gs.players['p2']!.zones.party).toHaveLength(0);
  });

  it('h_003 Vicious Wildcat: SLAY a monster then force end of turn', () => {
    const card = makeCard('h_003');
    const monster = makeMonster('m_001');
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', party: [card] }), buildPlayer({ id: 'p2' })],
      activeMonsters: [monster],
    });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    respond(h, gs, 'p1', monster.instanceId);
    expect(gs.players['p1']!.slainMonsters.map(c => c.instanceId)).toContain(monster.instanceId);
    expect(gs.activePlayerId).toBe('p2'); // turn was force-ended
  });

  it('h_008 Heavy Bear: a chosen player must discard 2 cards', () => {
    const card = makeCard('h_008');
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', party: [card] }), buildPlayer({ id: 'p2', hand: [makeCard('s_001'), makeCard('s_002')] })],
    });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    respond(h, gs, 'p1', 'p2');
    const p = h.socket('p2').lastPrompt();
    expect(p.promptType).toBe('discardCard');
    expect(p.message).toMatch(/2 card/);
  });

  it('h_019 Hollow Husk: take a Magic card from a chosen hand', () => {
    const card = makeCard('h_019');
    const magic = makeCard('s_002');
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', party: [card] }), buildPlayer({ id: 'p2', hand: [magic, makeCard('h_043')] })],
    });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    respond(h, gs, 'p1', 'p2');             // choose the player
    respond(h, gs, 'p1', magic.instanceId); // take the magic card
    expect(gs.players['p1']!.zones.hand.map(c => c.instanceId)).toContain(magic.instanceId);
  });

  it('h_025 Beary Wise: opponents discard, then the caster takes one discarded card', () => {
    const card = makeCard('h_025');
    const a = makeCard('s_001'); const b = makeCard('s_002');
    const gs = buildGameState({
      players: [
        buildPlayer({ id: 'p1', party: [card] }),
        buildPlayer({ id: 'p2', hand: [a] }),
        buildPlayer({ id: 'p3', hand: [b] }),
      ],
    });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    respond(h, gs, 'p2', a.instanceId);
    respond(h, gs, 'p3', b.instanceId);
    // After everyone discards, the caster is prompted to take one of them.
    const take = h.socket('p1').lastPrompt();
    respond(h, gs, 'p1', take.options[0]!.id);
    expect(gs.players['p1']!.zones.hand).toHaveLength(1);
  });

  it('h_026 Fury Knuckle: a pulled Challenge grants a second pull', () => {
    const card = makeCard('h_026');
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', party: [card] }), buildPlayer({ id: 'p2', hand: [makeCard('chal_001'), makeCard('chal_002')] })],
    });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    respond(h, gs, 'p1', 'p2');
    expect(gs.players['p1']!.zones.hand).toHaveLength(2);
  });

  it('h_044 Lucky Bucky: a pulled Hero may be played immediately', () => {
    const card = makeCard('h_044');
    const hero = makeCard('h_006');
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', party: [card] }), buildPlayer({ id: 'p2', hand: [hero] })],
    });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    respond(h, gs, 'p1', 'p2');
    expect(gs.players['p1']!.zones.hand.map(c => c.instanceId)).toContain(hero.instanceId);
    expect(h.socket('p1').lastPrompt().promptType).toBe('confirm');
  });

  it('h_051 Sly Pickings: a pulled Item may be played immediately', () => {
    const card = makeCard('h_051');
    const item = makeCard('i_001');
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', party: [card] }), buildPlayer({ id: 'p2', hand: [item] })],
    });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    respond(h, gs, 'p1', 'p2');
    expect(gs.players['p1']!.zones.hand.map(c => c.instanceId)).toContain(item.instanceId);
    expect(h.socket('p1').lastPrompt().promptType).toBe('confirm');
  });
});

describe('hero active skills — whiff (no legal target → not consumed, retryable)', () => {
  it('h_027 Bad Axe: with no enemy heroes, the ability is NOT consumed and reports failure', () => {
    const card = makeCard('h_027');
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1', party: [card] }), buildPlayer({ id: 'p2' })] });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    expect(card.effectUsedThisTurn).toBe(false); // retryable
    expect(h.socket('p1').emittedOf('actionFailed').length).toBeGreaterThan(0);
    expect(h.socket('p1').prompts()).toHaveLength(0);
  });

  it('h_049 Kit Napper: with no enemy heroes to steal, the ability is NOT consumed', () => {
    const card = makeCard('h_049');
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1', party: [card] }), buildPlayer({ id: 'p2' })] });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    expect(card.effectUsedThisTurn).toBe(false);
    expect(h.socket('p1').emittedOf('actionFailed').length).toBeGreaterThan(0);
  });

  it('h_003 Vicious Wildcat: with no monsters, the SLAY whiffs so the turn is NOT ended', () => {
    // Principle: a targeted effect with no legal target aborts the whole ability, so the
    // unconditional FORCE_END_TURN follow-up does not fire.
    const card = makeCard('h_003');
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1', party: [card] }), buildPlayer({ id: 'p2' })], activeMonsters: [] });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    expect(card.effectUsedThisTurn).toBe(false);
    expect(gs.activePlayerId).toBe('p1'); // turn was NOT force-ended
    expect(h.socket('p1').emittedOf('actionFailed').length).toBeGreaterThan(0);
  });

  it('h_045 Napping Nibbles: NOOP changes nothing but IS consumed (intentional no-op)', () => {
    const card = makeCard('h_045');
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1', party: [card] }), buildPlayer({ id: 'p2' })] });
    const h = createHarness(gs);
    activate(h, gs, 'p1', card.instanceId);
    expect(card.effectUsedThisTurn).toBe(true);
  });
});
