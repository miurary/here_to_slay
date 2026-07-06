// monsters.ts — extracted from the original monolithic server.ts.
import { roll2d6 } from './dice.js';
import type {
  ClientToServerEvents, ServerToClientEvents,
  CardInstance, CardTemplate, Effect, GameState, Player, MonsterInstance,
} from '../../shared/src/types.js';
import type { Socket } from 'socket.io';
import { emitAbilityPrompt, buildPromptId, getIo, modifierPhases } from './state.js';
import type { ModifierPhaseState } from './state.js';
import { getHeroEffectiveClass, applyWinIfMet } from './util.js';
import { logEvent, nameOf } from './log.js';
import { drawCardsForPlayer } from './effects.js';
import { getSlainMonsterRollBonus, getOpponentsWithModifiers, updateModifierPhaseGameState } from './rolls.js';


const checkMonsterRequirements = (gameState: GameState, player: Player, monsterTemplate: CardTemplate | undefined): { met: boolean; missing: string } => {
  if (!monsterTemplate) return { met: false, missing: 'Monster template not found' };
  const reqs = monsterTemplate.requirements ?? [];
  for (const req of reqs) {
    const classLower = req.class.toLowerCase();
    if (classLower === 'hero') {
      const count = player.zones.party.filter((c: CardInstance) => c.cardType === 'hero').length;
      if (count < req.amount) return { met: false, missing: `${req.amount} hero card${req.amount > 1 ? 's' : ''} in party (have ${count})` };
    } else {
      const count = player.zones.party.filter((c: CardInstance) => {
        const effectiveClass = getHeroEffectiveClass(gameState, player, c);
        return effectiveClass?.toLowerCase() === classLower;
      }).length;
      if (count < req.amount) return { met: false, missing: `${req.amount} ${req.class} hero${req.amount > 1 ? 's' : ''} in party (have ${count})` };
    }
  }
  return { met: true, missing: '' };
};
const getMonsterAttackRollBonus = (gameState: GameState, player: Player): number => {
  let bonus = 0;
  // p_005 Divine Arrow (party leader) — +1 to ATTACK rolls
  if (player.partyLeaderId) {
    const leaderTemplate = gameState.cardTemplates[player.partyLeaderId];
    if (
      leaderTemplate?.effect?.triggerEvent === 'ON_ATTACK_ROLL' &&
      leaderTemplate.effect.action === 'APPLY_ROLL_MODIFIER'
    ) bonus += leaderTemplate.effect.amount ?? 0;
  }
  // m_013 Reptilian Ripper / m_016 Anuran Cauldron (slain monsters)
  bonus += getSlainMonsterRollBonus(gameState, player, 'ATTACK_MONSTER_ROLLS');
  return bonus;
};

// All slain effects (EXTRA_AP, blockItemChallenges, PERSISTENT_MODIFIER) are read
// dynamically from player.slainMonsters at the point of use — no extra setup needed here.
const applySlainEffect = () => {};

const promptMonsterDiscard = (
  socket: Socket<ClientToServerEvents, ServerToClientEvents>,
  gameState: GameState,
  player: Player,
  monsterInstanceId: string,
  monsterName: string,
  remaining: number,
  finalRoll: number,
  effectText: string,
  sendRoomUpdate: () => void
) => {
  const opts = player.zones.hand.map((c: CardInstance) => ({
    id: c.instanceId,
    label: gameState.cardTemplates[c.templateId]?.name || c.templateId,
    payload: { cardInstanceId: c.instanceId },
  }));
  emitAbilityPrompt(socket.id, {
    promptId: buildPromptId(),
    roomCode: socket.data.roomCode as string,
    heroInstanceId: monsterInstanceId,
    sourcePlayerId: socket.id,
    promptType: 'discardCard',
    message: `Discard ${remaining} card${remaining > 1 ? 's' : ''} (monster penalty).`,
    options: opts,
    effect: { action: 'MONSTER_DISCARD', remaining, monsterName, finalRoll, effectText },
    remainingEffects: [],
    isMonsterEffect: true,
  });
  sendRoomUpdate();
};

const promptMonsterSacrifice = (
  socket: Socket<ClientToServerEvents, ServerToClientEvents>,
  gameState: GameState,
  player: Player,
  monsterInstanceId: string,
  monsterName: string,
  finalRoll: number,
  effectText: string,
  remaining: number,
  sendRoomUpdate: () => void
) => {
  const heroOptions = player.zones.party
    .filter((c: CardInstance) => c.cardType === 'hero')
    .map((c: CardInstance) => ({
      id: c.instanceId,
      label: gameState.cardTemplates[c.templateId]?.name || c.templateId,
      payload: { cardInstanceId: c.instanceId },
    }));
  if (heroOptions.length === 0) { sendRoomUpdate(); return; }
  emitAbilityPrompt(socket.id, {
    promptId: buildPromptId(),
    roomCode: socket.data.roomCode as string,
    heroInstanceId: monsterInstanceId,
    sourcePlayerId: socket.id,
    promptType: 'selectCard',
    message: `Sacrifice ${remaining} Hero card${remaining > 1 ? 's' : ''} (monster penalty).`,
    options: heroOptions,
    effect: { action: 'MONSTER_SACRIFICE_HERO', monsterName, finalRoll, effectText, remaining },
    remainingEffects: [],
    isMonsterEffect: true,
  });
  sendRoomUpdate();
};

const applyMonsterAttackEffects = (
  roomCode: string,
  socket: Socket<ClientToServerEvents, ServerToClientEvents>,
  gameState: GameState,
  player: Player,
  monster: MonsterInstance,
  monsterTemplate: CardTemplate,
  finalTotal: number,
  sendRoomUpdate: () => void
) => {
  const upperBound = monsterTemplate.upperBound ?? 99;
  const lowerBound = monsterTemplate.lowerBound ?? 0;
  const monsterName = monsterTemplate.name ?? monster.templateId;

  let effects: Effect[] = [];
  let effectText = '';

  if (finalTotal >= upperBound) {
    effects = monsterTemplate.upperBoundEffect ?? [];
    effectText = monsterTemplate.upperBoundText ?? '';
  } else if (finalTotal < lowerBound) {
    effects = monsterTemplate.lowerBoundEffect ?? [];
    effectText = monsterTemplate.lowerBoundText ?? '';
  }

  const slew = finalTotal >= upperBound;

  // Broadcast result immediately before any prompts
  getIo().to(roomCode).emit('monsterAttackResult', {
    attackerName: player.username ?? socket.id,
    monsterName,
    roll: finalTotal,
    requiredRoll: upperBound,
    slew,
    effectText: effectText || 'Nothing happens.',
  });

  logEvent(
    gameState,
    'action',
    slew
      ? `${nameOf(gameState, player.id)} slew ${monsterName}! (rolled ${finalTotal})`
      : `${nameOf(gameState, player.id)}'s attack on ${monsterName} failed (rolled ${finalTotal}, needed ${upperBound}).`,
    { id: player.id, username: player.username },
  );

  for (const effect of effects) {
    if (effect.action === 'SLAY') {
      const monsterIdx = gameState.activeMonsters.findIndex((m: MonsterInstance) => m.instanceId === monster.instanceId);
      if (monsterIdx !== -1) {
        const [slainMonster] = gameState.activeMonsters.splice(monsterIdx, 1);
        if (slainMonster) {
          player.slainMonsters = player.slainMonsters ?? [];
          player.slainMonsters.push(slainMonster);
          // p_001 Raging Manticore: draw N cards on slay
          if (player.partyLeaderId) {
            const plTemplate = gameState.cardTemplates[player.partyLeaderId];
            if (plTemplate?.effect?.triggerEvent === 'ON_SLAY' && plTemplate.effect.action === 'DRAW') {
              drawCardsForPlayer(gameState, player, plTemplate.effect.amount ?? 1);
            }
          }
          if (gameState.monsterDeck.length > 0) {
            const [replacement] = gameState.monsterDeck.splice(0, 1);
            if (replacement) gameState.activeMonsters.push(replacement as MonsterInstance);
          }
          applySlainEffect();
        }
      }
    } else if (effect.action === 'DRAW') {
      drawCardsForPlayer(gameState, player, effect.amount ?? 1);
    } else if (effect.action === 'DISCARD') {
      const amount = effect.amount ?? 0;
      if (amount < 0 || player.zones.hand.length <= amount) {
        gameState.discardPile.push(...player.zones.hand);
        player.zones.hand = [];
      } else {
        promptMonsterDiscard(socket, gameState, player, monster.instanceId, monsterName, amount, finalTotal, effectText, sendRoomUpdate);
        return;
      }
    } else if (effect.action === 'SACRIFICE') {
      const count = Math.max(1, effect.amount ?? 1);
      promptMonsterSacrifice(socket, gameState, player, monster.instanceId, monsterName, finalTotal, effectText, count, sendRoomUpdate);
      return;
    }
  }

  applyWinIfMet(gameState, player, socket.id);

  sendRoomUpdate();
};

const executeMonsterAttackRoll = (
  roomCode: string,
  socket: Socket<ClientToServerEvents, ServerToClientEvents>,
  gameState: GameState,
  player: Player,
  monster: MonsterInstance,
  monsterTemplate: CardTemplate,
  sendRoomUpdate: () => void
) => {
  const [die1, die2] = roll2d6();
  const attackBonus = getMonsterAttackRollBonus(gameState, player);
  const rawDiceTotal = die1 + die2;
  const currentTotal = rawDiceTotal + attackBonus;
  const upperBound = monsterTemplate.upperBound ?? 99;
  const lowerBound = monsterTemplate.lowerBound ?? 0;
  const monsterName = monsterTemplate.name ?? monster.templateId;

  const opponentsWithModifiers = getOpponentsWithModifiers(gameState, socket.id);
  const rollerHasModifiers = player.zones.hand.some(c => c.cardType === 'modifier');
  const rollerNeedsPrompt = currentTotal < upperBound && rollerHasModifiers;

  const success = currentTotal >= upperBound;
  const statusWord = success ? 'Hit!' : currentTotal < lowerBound ? 'Penalty!' : 'Miss.';
  const message = `Attacked ${monsterName}: Rolled ${die1} + ${die2}${attackBonus ? ` + ${attackBonus}` : ''} = ${currentTotal}. ${statusWord} (need ${upperBound} to slay).`;
  socket.emit('heroRollResult', { heroInstanceId: monster.instanceId, die1, die2, total: currentTotal, requiredRoll: upperBound, success, message });

  if (!rollerNeedsPrompt && opponentsWithModifiers.length === 0) {
    applyMonsterAttackEffects(roomCode, socket, gameState, player, monster, monsterTemplate, currentTotal, sendRoomUpdate);
    return;
  }

  const initialPhase: 'roller_turn' | 'opponent_turn' = rollerNeedsPrompt ? 'roller_turn' : 'opponent_turn';
  const phaseState: ModifierPhaseState = {
    die1, die2, rawDiceTotal,
    persistentBonus: attackBonus,
    accumulatedModifier: 0,
    requiredRoll: upperBound,
    rollContext: 'ATTACK_MONSTER',
    rollType: 'monster_attack',
    heroInstanceId: monster.instanceId,
    rollingPlayerId: socket.id,
    phase: initialPhase,
    allOpponentsWithModifiers: opponentsWithModifiers,
    opponentQueue: [...opponentsWithModifiers],
    cardPlayedThisCycle: false,
    modifiersPlayed: [],
    monsterInstanceId: monster.instanceId,
    lowerBound,
  };

  modifierPhases.set(roomCode, phaseState);
  updateModifierPhaseGameState(roomCode, phaseState, gameState);
  sendRoomUpdate();
};
export {
  checkMonsterRequirements, getMonsterAttackRollBonus, applySlainEffect,
  promptMonsterDiscard, promptMonsterSacrifice, applyMonsterAttackEffects, executeMonsterAttackRoll,
};

