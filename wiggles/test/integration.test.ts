import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';

// Deterministic hero/attack dice for the real in-process server.
const dice = vi.hoisted(() => ({ next: [3, 3] as [number, number] }));
vi.mock('../src/dice.js', () => ({ roll2d6: () => dice.next, rollDie: () => dice.next[0] }));

import { startServer, stopServer, createRoom, connect, type TestClient } from './integration-helpers.js';
import { getRoomState } from '../src/state.js';
import { makeCard, makeMonster } from './harness.js';
import type { AbilityPrompt, AbilityPromptOption, GameState } from '../../shared/src/types.js';

let port: number;
const open: TestClient[] = [];

beforeAll(async () => { port = await startServer(); });
afterAll(async () => { await stopServer(); });
afterEach(() => { for (const c of open.splice(0)) c.close(); dice.next = [3, 3]; });

const newClient = async (roomCode: string, name: string, playerId?: string) => {
  const c = await connect(port, roomCode, name, playerId);
  open.push(c);
  return c;
};

/** Two connected players in a controlled in_progress game (A active). */
const setupInProgress = async () => {
  const roomCode = await createRoom(port);
  const a = await newClient(roomCode, 'A');
  const b = await newClient(roomCode, 'B');
  await a.waitState(gs => Object.keys(gs.players).length === 2);
  const gs = getRoomState(roomCode)!;
  gs.status = 'in_progress';
  gs.activePlayerId = a.id;
  gs.turnNumber = 1;
  gs.players[a.id]!.actionPoints = 3;
  gs.players[b.id]!.actionPoints = 3;
  return { roomCode, gs, a, b };
};

const promptOption = (prompt: AbilityPrompt, match: (o: AbilityPromptOption) => boolean) => prompt.options.find(match)?.id as string;

describe('integration — full lobby lifecycle over real sockets', () => {
  it('drives connect → startGame → rolls → leader selection → in_progress', async () => {
    const roomCode = await createRoom(port);
    const a = await newClient(roomCode, 'A');
    const b = await newClient(roomCode, 'B');
    await a.waitState(gs => Object.keys(gs.players).length === 2);

    b.emit('toggleReady'); // lobby leader (a) is exempt from readying up
    await a.waitState(gs => !!gs.players[b.id]?.ready);

    a.emit('startGame');
    await a.waitState(gs => gs.status === 'rolling');

    // rollForFirst: whoever is the current roller rolls, until rolling completes.
    const byId = (id: string | undefined) => [a, b].find(c => c.id === id)!;
    for (;;) {
      const gs = a.state()!;
      if (gs.status !== 'rolling') break;
      const before = gs.currentRollerId;
      byId(before).emit('rollForFirst');
      await a.waitState(g => g.currentRollerId !== before || g.status !== 'rolling');
    }
    await a.waitState(gs => gs.status === 'roll_complete');

    a.emit('continueGame'); // lobby leader = first connected
    await a.waitState(gs => gs.status === 'party_leader_selection');

    // Each player picks an available leader when it's their turn.
    for (;;) {
      const gs = a.state()!;
      if (!gs.currentSelectionPlayerId) break;
      const cur = byId(gs.currentSelectionPlayerId);
      const before = gs.currentSelectionPlayerId;
      cur.emit('choosePartyLeader', gs.availablePartyLeaderCards[0]!.instanceId);
      await a.waitState(g => g.currentSelectionPlayerId !== before);
    }
    await a.waitState(gs => gs.status === 'party_leader_review');

    a.emit('continueGame');
    const finalState = await a.waitState(gs => gs.status === 'in_progress');
    expect(finalState.activePlayerId).toBeTruthy();
    for (const id of Object.keys(finalState.players)) {
      expect(finalState.players[id]!.partyLeaderId).toBeTruthy(); // everyone has a leader
    }
  });
});

describe('integration — turn actions over real sockets', () => {
  it('drawFromMain emits cardDrawn and spends AP', async () => {
    const { gs, a } = await setupInProgress();
    gs.mainDeck = [makeCard('s_001')];
    a.emit('drawFromMain');
    await a.waitEvent('cardDrawn');
    const st = await a.waitState(g => g.players[a.id]!.zones.hand.length === 1);
    expect(st.players[a.id]!.actionPoints).toBe(2);
  });

  it('rejects an action when it is not your turn', async () => {
    const { gs, b } = await setupInProgress();
    gs.mainDeck = [makeCard('s_001')];
    b.emit('drawFromMain');
    const [msg] = await b.waitEvent('actionFailed');
    expect(String(msg)).toMatch(/not your turn/i);
  });

  it('playHero (unchallenged) puts the hero in the party', async () => {
    const { gs, a } = await setupInProgress();
    const hero = makeCard('h_043');
    gs.players[a.id]!.zones.hand = [hero];
    a.emit('playHero', hero.instanceId);
    await a.waitEvent('heroPlayAccepted');
    const st = await a.waitState(g => g.players[a.id]!.zones.party.some(c => c.instanceId === hero.instanceId));
    expect(st.players[a.id]!.zones.party).toHaveLength(1);
  });

  it('endTurn rotates the active player', async () => {
    const { a, b } = await setupInProgress();
    a.emit('endTurn');
    const st = await b.waitState(g => g.activePlayerId === b.id);
    expect(st.players[b.id]!.actionPoints).toBe(3);
  });

  it('mulligan redraws a full hand for 3 AP', async () => {
    const { gs, a } = await setupInProgress();
    gs.players[a.id]!.zones.hand = [makeCard('s_001'), makeCard('s_002')];
    gs.mainDeck = Array.from({ length: 6 }, (_, i) => makeCard(`s_00${i + 1}`));
    a.emit('mulligan');
    const st = await a.waitState(g => g.players[a.id]!.zones.hand.length === 5);
    expect(st.players[a.id]!.actionPoints).toBe(0);
  });

  it('pingServer replies with pongClient', async () => {
    const { a } = await setupInProgress();
    a.emit('pingServer');
    const [payload] = await a.waitEvent('pongClient');
    expect((payload as { message: string }).message).toMatch(/successful/i);
  });
});

describe('integration — challenge flow', () => {
  it('playHero opens a challenge window; a pass lets the hero resolve', async () => {
    const { gs, a, b } = await setupInProgress();
    const hero = makeCard('h_043');
    gs.players[a.id]!.zones.hand = [hero];
    gs.players[b.id]!.zones.hand = [makeCard('chal_001')];
    a.emit('playHero', hero.instanceId);
    await b.waitState(g => !!g.pendingChallenge);
    b.emit('passChallenge');
    const st = await a.waitState(g => g.players[a.id]!.zones.party.some(c => c.instanceId === hero.instanceId));
    expect(st.pendingChallenge).toBeUndefined();
  });

  it('playChallenge triggers a resolved challenge broadcast', async () => {
    const { gs, a, b } = await setupInProgress();
    const hero = makeCard('h_043');
    const chal = makeCard('chal_001');
    gs.players[a.id]!.zones.hand = [hero];
    gs.players[b.id]!.zones.hand = [chal];
    a.emit('playHero', hero.instanceId);
    await b.waitState(g => !!g.pendingChallenge);
    b.emit('playChallenge', chal.instanceId);
    const [result] = await a.waitEvent('challengeResolved');
    expect(result).toHaveProperty('challengerWon');
  });
});

describe('integration — ability prompt round-trips', () => {
  it('activateHeroAbility (Bad Axe) prompts then destroys the chosen hero', async () => {
    const { gs, a, b } = await setupInProgress();
    const badAxe = makeCard('h_027');
    const victim = makeCard('h_043');
    gs.players[a.id]!.zones.party = [badAxe];
    gs.players[b.id]!.zones.party = [victim];
    a.emit('activateHeroAbility', badAxe.instanceId);
    const [prompt] = await a.waitEvent('abilityPrompt') as [AbilityPrompt];
    a.emit('respondToAbilityPrompt', prompt.promptId, promptOption(prompt, (o: AbilityPromptOption) => o.id === victim.instanceId));
    // Wait on a post-destroy condition (victim in discard), not party emptiness —
    // the party was already empty in the connect-time broadcast.
    const st = await a.waitState(g => g.discardPile.some(c => c.instanceId === victim.instanceId));
    expect(st.players[b.id]!.zones.party).toHaveLength(0);
  });

  it('playMagic (Destructive Spell) chains a discard then a destroy', async () => {
    const { gs, a, b } = await setupInProgress();
    const spell = makeCard('s_001');
    const filler = makeCard('s_002');
    const victim = makeCard('h_043');
    gs.players[a.id]!.zones.hand = [spell, filler];
    gs.players[b.id]!.zones.party = [victim];
    a.emit('playMagic', spell.instanceId);
    const [discardPrompt] = await a.waitEvent('abilityPrompt') as [AbilityPrompt];
    a.emit('respondToAbilityPrompt', discardPrompt.promptId, filler.instanceId);
    const [destroyPrompt] = await a.waitEvent('abilityPrompt') as [AbilityPrompt];
    a.emit('respondToAbilityPrompt', destroyPrompt.promptId, victim.instanceId);
    await a.waitState(g => g.discardPile.some(c => c.instanceId === victim.instanceId));
  });
});

describe('integration — roll + modifier phase', () => {
  it('rollHeroAbility opens a modifier phase that an opponent can act in', async () => {
    const { gs, a, b } = await setupInProgress();
    const hero = makeCard('h_001'); // rollToPlay 7
    const mod = makeCard('mod_001');
    gs.players[a.id]!.zones.party = [hero];
    gs.players[b.id]!.zones.hand = [mod];
    dice.next = [3, 3]; // 6 < 7 → opponent gets a chance to modify
    a.emit('rollHeroAbility', hero.instanceId);
    await b.waitState(g => !!g.modifierPhase);
    b.emit('playModifier', mod.instanceId, 0); // +2
    b.emit('passModifier');
    const [result] = await a.waitEvent('heroRollResult');
    expect((result as { heroInstanceId: string }).heroInstanceId).toBe(hero.instanceId);
  });
});

describe('integration — monster attack', () => {
  it('attackMonster broadcasts a result and slays on a strong roll', async () => {
    const { gs, a } = await setupInProgress();
    const monster = makeMonster('m_007'); // upper 10, needs 1 hero
    gs.players[a.id]!.zones.party = [makeCard('h_043')];
    gs.activeMonsters = [monster];
    dice.next = [6, 6]; // 12 >= 10
    a.emit('attackMonster', monster.instanceId);
    const [result] = await a.waitEvent('monsterAttackResult');
    expect((result as { slew: boolean }).slew).toBe(true);
    await a.waitState(g => g.players[a.id]!.slainMonsters.length === 1);
  });
});

describe('integration — party leader ability', () => {
  it('usePartyLeaderAbility (Shadow Claw) pulls a card from a chosen opponent', async () => {
    const { gs, a, b } = await setupInProgress();
    gs.players[a.id]!.zones.party = [makeCard('p_006')];
    gs.players[a.id]!.partyLeaderId = 'p_006';
    gs.players[b.id]!.zones.hand = [makeCard('s_001')];
    a.emit('usePartyLeaderAbility');
    const [prompt] = await a.waitEvent('abilityPrompt') as [AbilityPrompt];
    a.emit('respondToAbilityPrompt', prompt.promptId, prompt.options[0]?.id);
    const st = await a.waitState(g => g.players[a.id]!.zones.hand.length === 1);
    expect(st.players[b.id]!.zones.hand).toHaveLength(0);
  });
});

describe('integration — disconnect & reconnect', () => {
  it('holds a mid-game seat when the socket disconnects', async () => {
    const { a, b } = await setupInProgress();
    const bId = b.id;
    b.close();
    const st = await a.waitState((g: GameState) => g.players[bId]?.connected === false);
    expect(st.players[bId]!.connected).toBe(false);
  });

  it('reclaims the held seat (hand intact) on reconnect with the same playerId', async () => {
    const roomCode = await createRoom(port);
    const a = await newClient(roomCode, 'A');
    const b = await newClient(roomCode, 'B', 'pid-b');
    await a.waitState(gs => Object.keys(gs.players).length === 2);

    const gs = getRoomState(roomCode)!;
    gs.status = 'in_progress';
    gs.activePlayerId = a.id;
    gs.players['pid-b']!.zones.hand = [makeCard('s_001')];

    b.close();
    await a.waitState(g => g.players['pid-b']?.connected === false);

    const b2 = await newClient(roomCode, 'B', 'pid-b');
    const st = await a.waitState(g => g.players['pid-b']?.connected !== false);
    expect(st.players['pid-b']!.zones.hand).toHaveLength(1);
    expect(b2.id).not.toBe('pid-b'); // new socket, same seat
  });
});
