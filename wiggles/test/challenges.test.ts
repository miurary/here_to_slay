import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  getEligibleChallengerIds, getChallengeCardBonus,
  openChallengeWindow, executePendingCardPlay, resolveChallengeRollOff,
} from '../src/challenges.js';
import { createHarness, resetEngineState, buildGameState, buildPlayer, makeCard, templates } from './harness.js';

beforeEach(() => resetEngineState());

describe('challenge cards — bonuses & eligibility', () => {
  const t = (id: string) => templates()[id];

  it('getChallengeCardBonus: plain challenge 0, class challenges +3', () => {
    expect(getChallengeCardBonus(t('chal_001'))).toBe(0);
    expect(getChallengeCardBonus(t('chal_002'))).toBe(3);
    expect(getChallengeCardBonus(t('chal_003'))).toBe(3);
  });

  it('an opponent holding a plain challenge is eligible', () => {
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1' }), buildPlayer({ id: 'p2', hand: [makeCard('chal_001')] })] });
    expect(getEligibleChallengerIds(gs, 'p1')).toEqual(['p2']);
  });

  it('blockAllChallenges room flag makes everyone ineligible', () => {
    const gs = buildGameState({
      players: [buildPlayer({ id: 'p1' }), buildPlayer({ id: 'p2', hand: [makeCard('chal_001')] })],
      roomFlags: { blockAllChallenges: true },
    });
    expect(getEligibleChallengerIds(gs, 'p1')).toEqual([]);
  });

  it('a class challenge (Berserker) requires a matching hero in the challenger party', () => {
    const without = buildGameState({ players: [buildPlayer({ id: 'p1' }), buildPlayer({ id: 'p2', hand: [makeCard('chal_002')] })] });
    expect(getEligibleChallengerIds(without, 'p1')).toEqual([]);
    const withBerserker = buildGameState({
      players: [buildPlayer({ id: 'p1' }), buildPlayer({ id: 'p2', hand: [makeCard('chal_002')], party: [makeCard('h_003')] })], // h_003 berserker
    });
    expect(getEligibleChallengerIds(withBerserker, 'p1')).toEqual(['p2']);
  });
});

describe('challenge window resolution', () => {
  it('openChallengeWindow records the pending challenge in game state', () => {
    const pendingCard = makeCard('h_043');
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1' }), buildPlayer({ id: 'p2' })] });
    const h = createHarness(gs);
    openChallengeWindow(h.roomCode, gs, {
      pendingCardInstance: pendingCard, pendingPlayerId: 'p1', pendingCardType: 'hero',
      eligibleChallengerIds: ['p2'], passedPlayerIds: new Set(), challengerRollBonus: 0,
    });
    expect(gs.pendingChallenge?.pendingPlayerId).toBe('p1');
    expect(gs.pendingChallenge?.pendingCardType).toBe('hero');
    expect(gs.pendingChallenge?.eligibleChallengerIds).toEqual(['p2']);
  });

  it('executePendingCardPlay puts an unchallenged hero into the party', () => {
    const pendingCard = makeCard('h_043');
    const gs = buildGameState({ players: [buildPlayer({ id: 'p1' }), buildPlayer({ id: 'p2' })] });
    const h = createHarness(gs);
    executePendingCardPlay(h.roomCode, {
      pendingCardInstance: pendingCard, pendingPlayerId: 'p1', pendingCardType: 'hero',
      eligibleChallengerIds: [], passedPlayerIds: new Set(), challengerRollBonus: 0,
    }, gs);
    expect(gs.players['p1']!.zones.party.map(c => c.instanceId)).toContain(pendingCard.instanceId);
  });

  describe('resolveChallengeRollOff (dice mocked)', () => {
    afterEach(() => vi.restoreAllMocks());

    const setup = () => {
      const pendingCard = makeCard('h_043');
      const challengeCard = makeCard('chal_001');
      const gs = buildGameState({
        players: [buildPlayer({ id: 'p1' }), buildPlayer({ id: 'p2', hand: [challengeCard] })],
      });
      const h = createHarness(gs);
      const pending = {
        pendingCardInstance: pendingCard, pendingPlayerId: 'p1', pendingCardType: 'hero' as const,
        eligibleChallengerIds: ['p2'], passedPlayerIds: new Set<string>(),
        challengerId: 'p2', challengeCardInstanceId: challengeCard.instanceId, challengerRollBonus: 0,
      };
      return { gs, h, pendingCard, challengeCard, pending };
    };

    it('challenger wins → the played card is discarded', () => {
      const { gs, h, pendingCard, pending } = setup();
      // rolls in order: challenger d1,d2 (high), challenged d1,d2 (low)
      vi.spyOn(Math, 'random').mockReturnValueOnce(0.99).mockReturnValueOnce(0.99).mockReturnValueOnce(0).mockReturnValueOnce(0);
      resolveChallengeRollOff(h.roomCode, pending, gs, h.sendRoomUpdate);
      expect(gs.discardPile.map(c => c.instanceId)).toContain(pendingCard.instanceId);
      expect(gs.players['p1']!.zones.party).toHaveLength(0);
    });

    it('challenger loses → the played card resolves (hero enters the party)', () => {
      const { gs, h, pendingCard, pending } = setup();
      vi.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(0.99).mockReturnValueOnce(0.99);
      resolveChallengeRollOff(h.roomCode, pending, gs, h.sendRoomUpdate);
      expect(gs.players['p1']!.zones.party.map(c => c.instanceId)).toContain(pendingCard.instanceId);
    });
  });
});
