import { describe, it, expect, beforeEach } from 'vitest';
import { applyMonsterAttackEffects, checkMonsterRequirements, getMonsterAttackRollBonus } from '../src/monsters.js';
import { triggerSlainMonsterPassive, drawCardsForPlayer, resolveHeroDestruction } from '../src/effects.js';
import { getSlainMonsterRollBonus, getSlainOpponentModifierBonus } from '../src/rolls.js';
import { triggerEndTurn } from '../src/turns.js';
import { playerHasSlainEffectFlag, playerHasSlainEffectAction } from '../src/util.js';
import { handlePromptResponse } from '../src/promptResponse.js';
import {
  createHarness, resetEngineState, buildGameState, buildPlayer, makeCard, makeMonster,
  type Harness,
} from './harness.js';
import type { GameState, MonsterInstance } from '../../shared/src/types.js';

beforeEach(() => resetEngineState());

const attack = (h: Harness, gs: GameState, casterId: string, monster: MonsterInstance, total: number) => {
  const tmpl = gs.cardTemplates[monster.templateId]!;
  applyMonsterAttackEffects(h.roomCode, h.socket(casterId) as never, gs, gs.players[casterId]!, monster, tmpl, total, h.sendRoomUpdate);
};

const respond = (h: Harness, responderId: string, optionId: string) => {
  const prompt = h.socket(responderId).lastPrompt();
  handlePromptResponse(h.socket(responderId) as never, prompt.promptId, optionId, h.sendRoomUpdate);
};

describe('monster attack — reaching the upper bound slays the monster', () => {
  // Every monster except m_011 (whose upper-bound effect is SACRIFICE) slays on a hit.
  const slayOnHit = ['m_001','m_002','m_003','m_004','m_005','m_006','m_007','m_008','m_009','m_010','m_012','m_013','m_014','m_015','m_016','m_017'];
  for (const id of slayOnHit) {
    it(`${id}: total >= upperBound moves it to the player's slain pile`, () => {
      const monster = makeMonster(id);
      const gs = buildGameState({ players: [buildPlayer({ id: 'p1' }), buildPlayer({ id: 'p2' })], activeMonsters: [monster] });
      const h = createHarness(gs);
      attack(h, gs, 'p1', monster, gs.cardTemplates[id]!.upperBound ?? 99);
      expect(gs.players['p1']!.slainMonsters.map(c => c.instanceId)).toContain(monster.instanceId);
      expect(gs.activeMonsters).toHaveLength(0);
    });
  }
});

describe('monster attack — special hit bonuses & inverted monster', () => {
  it('m_002 Mega Slime: hit also draws 2 cards', () => {
    const monster = makeMonster('m_002');
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1' }), buildPlayer({ id: 'p2' })], activeMonsters: [monster], mainDeck: [makeCard('s_001'), makeCard('s_002'), makeCard('s_003')] });
    const h = createHarness(gs);
    attack(h, gs, 'p1', monster, 8);
    expect(gs.players['p1']!.slainMonsters).toHaveLength(1);
    expect(gs.players['p1']!.zones.hand).toHaveLength(2);
  });

  it('m_012 Corrupted Sabretooth: hit also draws 1 card', () => {
    const monster = makeMonster('m_012');
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1' }), buildPlayer({ id: 'p2' })], activeMonsters: [monster], mainDeck: [makeCard('s_001')] });
    const h = createHarness(gs);
    attack(h, gs, 'p1', monster, 9);
    expect(gs.players['p1']!.zones.hand).toHaveLength(1);
  });

  it('m_011 Dracos: inverted — a LOW roll slays it, a high roll forces a sacrifice', () => {
    const monster = makeMonster('m_011');
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1', party: [makeCard('h_043')] }), buildPlayer({ id: 'p2' })], activeMonsters: [monster] });
    const h = createHarness(gs);
    attack(h, gs, 'p1', monster, 5); // "roll 5 or less" → exactly 5 slays
    expect(gs.players['p1']!.slainMonsters.map(c => c.instanceId)).toContain(monster.instanceId);
  });

  it('a middling roll (between bounds) has no effect', () => {
    const monster = makeMonster('m_001'); // bounds 4..8
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1', hand: [makeCard('s_001')] }), buildPlayer({ id: 'p2' })], activeMonsters: [monster] });
    const h = createHarness(gs);
    attack(h, gs, 'p1', monster, 6);
    expect(gs.players['p1']!.slainMonsters).toHaveLength(0);
    expect(gs.activeMonsters).toHaveLength(1);
    expect(gs.players['p1']!.zones.hand).toHaveLength(1);
  });
});

// Regression guards: bounds are INCLUSIVE ("8+" hits at 8, "4−" at 4) and the
// slain/failed outcome is read from which effect actually fired, not from
// which bound was crossed (m_011 Dracos slays on a LOW roll).
describe('monster attack — inclusive bounds & inverted slay (regression)', () => {
  const lastAttackBroadcast = (h: Harness) => {
    const bs = h.io.broadcasts.filter(b => b.event === 'monsterAttackResult');
    return bs[bs.length - 1]!.args[0] as { slew: boolean; requiredRoll: number; slayOnLow?: boolean; effectText: string };
  };

  it('m_001 Doombringer: rolling exactly the lower bound (4) triggers the penalty', () => {
    const monster = makeMonster('m_001');
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1', hand: [makeCard('s_001'), makeCard('s_002')] }), buildPlayer({ id: 'p2' })], activeMonsters: [monster] });
    const h = createHarness(gs);
    attack(h, gs, 'p1', monster, 4); // card says "4−": 4 counts
    expect(gs.players['p1']!.zones.hand).toHaveLength(0);
    expect(gs.discardPile).toHaveLength(2);
  });

  it('m_002 Mega Slime: rolling exactly 7 forces the sacrifice — there is no neutral gap', () => {
    const monster = makeMonster('m_002'); // slay 8+, penalty 7−
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1', party: [makeCard('h_043')] }), buildPlayer({ id: 'p2' })], activeMonsters: [monster] });
    const h = createHarness(gs);
    attack(h, gs, 'p1', monster, 7);
    expect(h.socket('p1').lastPrompt().message).toMatch(/Sacrifice 1 Hero/);
  });

  it('m_011 Dracos: a slaying LOW roll broadcasts slew=true with the "5 or less" target', () => {
    const monster = makeMonster('m_011');
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1', party: [makeCard('h_043')] }), buildPlayer({ id: 'p2' })], activeMonsters: [monster] });
    const h = createHarness(gs);
    attack(h, gs, 'p1', monster, 5);
    expect(gs.players['p1']!.slainMonsters).toHaveLength(1);
    const result = lastAttackBroadcast(h);
    expect(result.slew).toBe(true);
    expect(result.requiredRoll).toBe(5);
    expect(result.slayOnLow).toBe(true);
  });

  it('m_011 Dracos: a HIGH roll is the penalty — broadcast says slew=false and the chosen hero is sacrificed', () => {
    const monster = makeMonster('m_011');
    const hero = makeCard('h_043');
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1', party: [hero] }), buildPlayer({ id: 'p2' })], activeMonsters: [monster] });
    const h = createHarness(gs);
    attack(h, gs, 'p1', monster, 9); // ≥ upperBound 8 → SACRIFICE, not a slay
    expect(lastAttackBroadcast(h).slew).toBe(false);
    expect(gs.players['p1']!.slainMonsters).toHaveLength(0);
    expect(gs.activeMonsters).toHaveLength(1); // Dracos survives

    // The sacrifice prompt resolves: the hero leaves the party for the discard pile.
    expect(h.socket('p1').lastPrompt().promptType).toBe('selectCard');
    respond(h, 'p1', hero.instanceId);
    expect(gs.players['p1']!.zones.party).toHaveLength(0);
    expect(gs.discardPile.map(c => c.instanceId)).toContain(hero.instanceId);
  });

  it('m_011 Dracos: a middling roll (6–7) does nothing', () => {
    const monster = makeMonster('m_011');
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1', party: [makeCard('h_043')] }), buildPlayer({ id: 'p2' })], activeMonsters: [monster] });
    const h = createHarness(gs);
    attack(h, gs, 'p1', monster, 7);
    expect(gs.players['p1']!.slainMonsters).toHaveLength(0);
    expect(gs.activeMonsters).toHaveLength(1);
    expect(gs.players['p1']!.zones.party).toHaveLength(1);
    expect(h.socket('p1').prompts()).toHaveLength(0);
  });
});

describe('monster attack — lower-bound penalties', () => {
  it('m_001 Doombringer: a low roll discards your whole hand', () => {
    const monster = makeMonster('m_001');
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1', hand: [makeCard('s_001'), makeCard('s_002')] }), buildPlayer({ id: 'p2' })], activeMonsters: [monster] });
    const h = createHarness(gs);
    attack(h, gs, 'p1', monster, 3); // < 4
    expect(gs.players['p1']!.zones.hand).toHaveLength(0);
    expect(gs.discardPile).toHaveLength(2);
  });

  it('m_003 Warworn Owlbear: a low roll prompts discarding 2 cards', () => {
    const monster = makeMonster('m_003');
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1', hand: [makeCard('s_001'), makeCard('s_002'), makeCard('s_003')] }), buildPlayer({ id: 'p2' })], activeMonsters: [monster] });
    const h = createHarness(gs);
    attack(h, gs, 'p1', monster, 3);
    expect(h.socket('p1').lastPrompt().promptType).toBe('discardCard');
  });

  it('m_006 Crowned Serpent: a low roll prompts a hero sacrifice', () => {
    const monster = makeMonster('m_006');
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1', party: [makeCard('h_043')] }), buildPlayer({ id: 'p2' })], activeMonsters: [monster] });
    const h = createHarness(gs);
    attack(h, gs, 'p1', monster, 6); // < 7
    expect(h.socket('p1').lastPrompt().promptType).toBe('selectCard');
    expect(h.socket('p1').lastPrompt().message).toMatch(/Sacrifice 1 Hero/);
  });

  it('m_013 Reptilian Ripper: a low roll prompts sacrificing 2 heroes', () => {
    const monster = makeMonster('m_013');
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1', party: [makeCard('h_043'), makeCard('h_006')] }), buildPlayer({ id: 'p2' })], activeMonsters: [monster] });
    const h = createHarness(gs);
    attack(h, gs, 'p1', monster, 5); // < 6
    expect(h.socket('p1').lastPrompt().message).toMatch(/Sacrifice 2 Hero/);
  });
});

describe('monster slain passives — persistent roll bonuses', () => {
  const withSlain = (id: string) =>
    buildGameState({ players: [buildPlayer({ id: 'p1', slainMonsters: [makeMonster(id)] }), buildPlayer({ id: 'p2' })] });

  it('m_004 Dark Dragon King: +1 to hero-ability rolls', () => {
    const gs = withSlain('m_004');
    expect(getSlainMonsterRollBonus(gs, gs.players['p1']!, 'HERO_ABILITY_ROLLS')).toBe(1);
  });

  it('m_013 Reptilian Ripper: +2 to monster-attack rolls', () => {
    const gs = withSlain('m_013');
    expect(getSlainMonsterRollBonus(gs, gs.players['p1']!, 'ATTACK_MONSTER_ROLLS')).toBe(2);
    expect(getMonsterAttackRollBonus(gs, gs.players['p1']!)).toBe(2);
  });

  it('m_015 Titan Wyvern: +1 to challenge rolls', () => {
    const gs = withSlain('m_015');
    expect(getSlainMonsterRollBonus(gs, gs.players['p1']!, 'CHALLENGE_ROLLS')).toBe(1);
  });

  it('m_016 Anuran Cauldron: +1 to ALL roll contexts', () => {
    const gs = withSlain('m_016');
    expect(getSlainMonsterRollBonus(gs, gs.players['p1']!, 'HERO_ABILITY_ROLLS')).toBe(1);
    expect(getSlainMonsterRollBonus(gs, gs.players['p1']!, 'CHALLENGE_ROLLS')).toBe(1);
  });

  it('m_017 Abyss Queen: a flat bonus only when an opponent plays a modifier', () => {
    const gs = withSlain('m_017');
    expect(getSlainOpponentModifierBonus(gs, gs.players['p1']!)).toBe(1);
    expect(getSlainMonsterRollBonus(gs, gs.players['p1']!, 'HERO_ABILITY_ROLLS')).toBe(0); // not a standard context
  });
});

describe('monster slain passives — flags', () => {
  it('m_003 Warworn Owlbear: grants the blockItemChallenges flag', () => {
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1', slainMonsters: [makeMonster('m_003')] }), buildPlayer({ id: 'p2' })] });
    expect(playerHasSlainEffectFlag(gs, gs.players['p1']!, 'blockItemChallenges')).toBe(true);
  });

  it('m_014 Terratuga: the owner\'s heroes cannot be destroyed', () => {
    const hero = makeCard('h_043');
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1' }), buildPlayer({ id: 'p2', party: [hero], slainMonsters: [makeMonster('m_014')] })] });
    expect(playerHasSlainEffectFlag(gs, gs.players['p2']!, 'blockHeroDestruction')).toBe(true);
    const msg = resolveHeroDestruction(gs, 'p2', hero.instanceId);
    expect(msg).toMatch(/cannot be destroyed/i);
    expect(gs.players['p2']!.zones.party.map(c => c.instanceId)).toContain(hero.instanceId);
  });
});

describe('monster slain passives — reactive draws (optional)', () => {
  const reactiveDraw = (event: string, monsterId: string) => {
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', slainMonsters: [makeMonster(monsterId)] }), buildPlayer({ id: 'p2' })],
      mainDeck: [makeCard('s_001')],
    });
    const h = createHarness(gs);
    triggerSlainMonsterPassive(gs, 'p1', event);
    const prompt = h.socket('p1').lastPrompt();
    expect(prompt.promptType).toBe('confirm');
    respond(h, 'p1', 'yes');
    expect(gs.players['p1']!.zones.hand).toHaveLength(1);
  };

  it('m_006 Crowned Serpent: ON_MODIFIER_PLAYED_ANY may draw a card', () => reactiveDraw('ON_MODIFIER_PLAYED_ANY', 'm_006'));
  it('m_007 Arctic Aries: ON_HERO_ABILITY_SUCCESS may draw a card', () => reactiveDraw('ON_HERO_ABILITY_SUCCESS', 'm_007'));
  it('m_011 Dracos: ON_HERO_DESTROYED may draw a card', () => reactiveDraw('ON_HERO_DESTROYED', 'm_011'));

  it('m_005 Rex Major: drawing a Modifier offers a bonus draw', () => {
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', slainMonsters: [makeMonster('m_005')] }), buildPlayer({ id: 'p2' })],
      mainDeck: [makeCard('mod_001'), makeCard('s_001')],
    });
    const h = createHarness(gs);
    drawCardsForPlayer(gs, gs.players['p1']!, 1); // draws the modifier → triggers the passive
    expect(h.socket('p1').lastPrompt().promptType).toBe('confirm');
    respond(h, 'p1', 'yes');
    expect(gs.players['p1']!.zones.hand).toHaveLength(2);
  });
});

describe('monster slain passives — other reactions', () => {
  it('m_001 Doombringer: ON_SACRIFICE picks a card from the discard pile', () => {
    const wanted = makeCard('s_001');
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', slainMonsters: [makeMonster('m_001')] }), buildPlayer({ id: 'p2' })],
      discardPile: [wanted],
    });
    const h = createHarness(gs);
    triggerSlainMonsterPassive(gs, 'p1', 'ON_SACRIFICE');
    respond(h, 'p1', wanted.instanceId);
    expect(gs.players['p1']!.zones.hand.map(c => c.instanceId)).toContain(wanted.instanceId);
  });

  it('m_008 Orthus: drawing a Magic card offers to play it immediately', () => {
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', slainMonsters: [makeMonster('m_008')] }), buildPlayer({ id: 'p2' })],
      mainDeck: [makeCard('s_002')],
    });
    const h = createHarness(gs);
    drawCardsForPlayer(gs, gs.players['p1']!, 1);
    expect(h.socket('p1').lastPrompt().promptType).toBe('confirm'); // play-it-now offer
  });

  it('m_010 Malamammoth: drawing an Item offers to equip it immediately', () => {
    const freeHero = makeCard('h_043');
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1', party: [freeHero], slainMonsters: [makeMonster('m_010')] }), buildPlayer({ id: 'p2' })],
      mainDeck: [makeCard('i_001')],
    });
    const h = createHarness(gs);
    drawCardsForPlayer(gs, gs.players['p1']!, 1);
    expect(h.socket('p1').lastPrompt().promptType).toBe('selectCard'); // equip-it-now offer
  });

  it('m_002 Mega Slime: grants +1 action point at the owner\'s turn start', () => {
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1' }), buildPlayer({ id: 'p2', slainMonsters: [makeMonster('m_002')] })],
      activePlayerId: 'p1',
    });
    const h = createHarness(gs);
    triggerEndTurn('p1', gs, h.roomCode, h.sendRoomUpdate); // advances to p2
    expect(gs.activePlayerId).toBe('p2');
    expect(gs.players['p2']!.actionPoints).toBe(4); // base 3 + EXTRA_AP 1
  });

  it('m_012 Corrupted Sabretooth: enables steal-instead-of-destroy', () => {
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1', slainMonsters: [makeMonster('m_012')] }), buildPlayer({ id: 'p2' })] });
    expect(playerHasSlainEffectAction(gs, gs.players['p1']!, 'STEAL_INSTEAD_OF_DESTROY')).toBe(true);
  });

  it('m_009 Bloodwing: enables forcing a challenger to discard', () => {
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1', slainMonsters: [makeMonster('m_009')] }), buildPlayer({ id: 'p2' })] });
    expect(playerHasSlainEffectAction(gs, gs.players['p1']!, 'FORCE_CHALLENGER_DISCARD')).toBe(true);
  });
});

describe('monster attack requirements', () => {
  it('m_001 Doombringer: needs a Necromancer + a Hero in the party', () => {
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1', party: [makeCard('h_001')] }), buildPlayer({ id: 'p2' })] }); // h_001 is a necromancer
    expect(checkMonsterRequirements(gs, gs.players['p1']!, gs.cardTemplates['m_001']).met).toBe(true);
  });

  it('m_001 Doombringer: unmet when the party lacks a Necromancer', () => {
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1', party: [makeCard('h_043')] }), buildPlayer({ id: 'p2' })] }); // bard only
    const check = checkMonsterRequirements(gs, gs.players['p1']!, gs.cardTemplates['m_001']);
    expect(check.met).toBe(false);
    expect(check.missing).toMatch(/necromancer/i);
  });
});
