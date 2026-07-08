// rolls.ts — extracted from the original monolithic server.ts.
import { roll2d6 } from './dice.js';
import type {
  ClientToServerEvents, ServerToClientEvents,
  CardInstance, CardTemplate, Effect, GameState, Player, PlayerState,
} from '../../shared/src/types.js';
import type { Socket } from 'socket.io';
import { getSocketByPlayerId, modifierPhases, pidOf } from './state.js';
import type { ModifierPhaseState } from './state.js';
import { getPlayerRollBonus } from './util.js';
import { logGame } from './analytics.js';
import { triggerSlainMonsterPassive } from './effects.js';
import { emitItemTriggerPrompt } from './items.js';
import { applyMonsterAttackEffects } from './monsters.js';


const getPartyLeaderHeroAbilityBonus = (gameState: GameState, playerId: string): number => {
  const player = gameState.players[playerId];
  if (!player?.partyLeaderId) return 0;
  const leaderTemplate = gameState.cardTemplates[player.partyLeaderId];
  if (
    leaderTemplate?.effect?.triggerEvent === 'ON_HERO_ABILITY_ROLL' &&
    leaderTemplate.effect.action === 'PERSISTENT_MODIFIER' &&
    leaderTemplate.effect.applies_to === 'HERO_ABILITY_ROLLS'
  ) return leaderTemplate.effect.modifier ?? 0;
  return 0;
};

// Sums the flat roll bonuses granted by slain monsters whose slainEffect is a
// PERSISTENT_MODIFIER targeting the given roll context. A slainEffect with
// applies_to === 'ALL_ROLLS' (Anuran Cauldron) matches every context.
// NOTE: 'OPPONENT_MODIFIER_REACTION' (Abyss Queen) is intentionally NOT summed
// here — it is a reactive bonus applied inside the modifier phase (see playModifier).
type RollContextTag = 'HERO_ABILITY_ROLLS' | 'CHALLENGE_ROLLS' | 'ATTACK_MONSTER_ROLLS';
const getSlainMonsterRollBonus = (
  gameState: GameState,
  player: Player,
  context: RollContextTag,
): number =>
  (player.slainMonsters ?? []).reduce((total, m: CardInstance) => {
    const slain = gameState.cardTemplates[m.templateId]?.slainEffect;
    if (slain?.action !== 'PERSISTENT_MODIFIER') return total;
    if (slain.applies_to === context || slain.applies_to === 'ALL_ROLLS') {
      return total + (slain.modifier ?? 0);
    }
    return total;
  }, 0);

// m_017 Abyss Queen — flat bonus the roller gains each time an opponent plays a
// modifier on their roll. Read reactively inside the modifier phase (playModifier).
const getSlainOpponentModifierBonus = (gameState: GameState, player: Player): number =>
  (player.slainMonsters ?? []).reduce((total, m: CardInstance) => {
    const slain = gameState.cardTemplates[m.templateId]?.slainEffect;
    return slain?.action === 'PERSISTENT_MODIFIER' && slain.applies_to === 'OPPONENT_MODIFIER_REACTION'
      ? total + (slain.modifier ?? 0)
      : total;
  }, 0);


const getOpponentsWithModifiers = (gameState: GameState, rollingPlayerId: string): string[] =>
  Object.entries(gameState.players)
    .filter(([pid]) => pid !== rollingPlayerId)
    .filter(([, p]) => (p as PlayerState).zones.hand.some((c: CardInstance) => c.cardType === 'modifier'))
    .map(([pid]) => pid);

const getModifierAmount = (template: CardTemplate | undefined, choiceIndex: number, rollContext: string): number => {
  const choices = template?.choices;
  if (choices) {
    const choice = choices[choiceIndex];
    if (!choice) return 0;
    const upgrades = choice.conditionalUpgrades;
    if (upgrades) {
      for (const upgrade of upgrades) {
        if (upgrade.condition?.rollContext === rollContext) {
          return upgrade.effects?.[0]?.amount ?? 0;
        }
      }
    }
    return choice.effects?.[0]?.amount ?? 0;
  }
  return template?.effects?.[0]?.amount ?? 0;
};

const getModifierChoiceLabel = (template: CardTemplate | undefined, choiceIndex: number, rollContext: string): string => {
  const choices = template?.choices;
  if (choices) {
    const choice = choices[choiceIndex];
    if (!choice) return '?';
    const upgrades = choice.conditionalUpgrades;
    if (upgrades) {
      for (const upgrade of upgrades) {
        if (upgrade.condition?.rollContext === rollContext) return upgrade.label ?? choice.label ?? '?';
      }
    }
    return choice.label ?? '?';
  }
  const amount = template?.effects?.[0]?.amount ?? 0;
  return amount >= 0 ? `+${amount}` : `${amount}`;
};

// mod_007: "DISCARD your hand, +7". Returns true if the chosen modifier option
// carries a DISCARD_HAND side-effect (so the player discards the rest of their hand).
const modifierDiscardsHand = (template: CardTemplate | undefined, choiceIndex: number, rollContext: string): boolean => {
  const has = (effects: Effect[] | undefined): boolean => Array.isArray(effects) && effects.some(e => e.action === 'DISCARD_HAND');
  const choices = template?.choices;
  if (choices) {
    const choice = choices[choiceIndex];
    if (!choice) return false;
    for (const upgrade of choice.conditionalUpgrades ?? []) {
      if (upgrade.condition?.rollContext === rollContext && has(upgrade.effects)) return true;
    }
    return has(choice.effects);
  }
  return has(template?.effects);
};

const updateModifierPhaseGameState = (_roomCode: string, phase: ModifierPhaseState, gameState: GameState) => {
  const currentTotal = phase.rawDiceTotal + phase.persistentBonus + phase.accumulatedModifier;
  const activePlayerId = phase.phase === 'roller_turn' ? phase.rollingPlayerId : (phase.opponentQueue[0] ?? '');
  const monsterName = phase.monsterInstanceId ? gameState.cardTemplates[phase.monsterInstanceId]?.name : undefined;
  gameState.modifierPhase = {
    heroInstanceId: phase.heroInstanceId,
    rollingPlayerId: phase.rollingPlayerId,
    requiredRoll: phase.requiredRoll,
    currentTotal,
    die1: phase.die1,
    die2: phase.die2,
    persistentBonus: phase.persistentBonus,
    accumulatedModifier: phase.accumulatedModifier,
    phase: phase.phase,
    activePlayerId,
    rollContext: phase.rollContext,
    rollType: phase.rollType,
    modifiersPlayed: phase.modifiersPlayed,
    ...(monsterName !== undefined ? { monsterName } : {}),
    ...(phase.lowerBound !== undefined ? { lowerBound: phase.lowerBound } : {}),
  };
};

const finalizeRoll = (
  roomCode: string,
  phase: ModifierPhaseState,
  gameState: GameState,
  sendRoomUpdate: () => void
) => {
  const finalTotal = phase.rawDiceTotal + phase.persistentBonus + phase.accumulatedModifier;

  logGame(gameState, 'roll_finalized', {
    rollType: phase.rollType,
    die1: phase.die1,
    die2: phase.die2,
    persistentBonus: phase.persistentBonus,
    accumulatedModifier: phase.accumulatedModifier,
    finalTotal,
    requiredRoll: phase.requiredRoll,
    success: finalTotal >= phase.requiredRoll,
    modifiersPlayed: phase.modifiersPlayed,
    ...(phase.monsterInstanceId ? { monsterInstanceId: phase.monsterInstanceId } : {}),
  }, phase.rollingPlayerId);

  modifierPhases.delete(roomCode);
  delete gameState.modifierPhase;

  if (phase.rollType === 'monster_attack') {
    const monster = gameState.activeMonsters.find(m => m.instanceId === phase.monsterInstanceId);
    const player = gameState.players[phase.rollingPlayerId];
    const rollingSocket = getSocketByPlayerId(roomCode, phase.rollingPlayerId);
    if (monster && player && rollingSocket) {
      const monsterTemplate = gameState.cardTemplates[monster.templateId];
      if (monsterTemplate) applyMonsterAttackEffects(roomCode, rollingSocket, gameState, player, monster, monsterTemplate, finalTotal, sendRoomUpdate);
      else sendRoomUpdate();
    } else {
      sendRoomUpdate();
    }
    return;
  }

  // hero_ability path
  const success = finalTotal >= phase.requiredRoll;
  const { die1, die2, persistentBonus, accumulatedModifier } = phase;
  const parts: string[] = [`Rolled ${die1} + ${die2}`];
  if (persistentBonus) parts.push(`+ ${persistentBonus}`);
  if (accumulatedModifier) parts.push(accumulatedModifier >= 0 ? `+ ${accumulatedModifier} (modifiers)` : `- ${Math.abs(accumulatedModifier)} (modifiers)`);
  parts.push(`= ${finalTotal}`);
  const message = `${parts.join(' ')}. ${success ? 'Success!' : 'Failed.'} (needed ${phase.requiredRoll}).`;

  const rollingSocket = getSocketByPlayerId(roomCode, phase.rollingPlayerId);
  if (rollingSocket) {
    rollingSocket.emit('heroRollResult', {
      heroInstanceId: phase.heroInstanceId,
      die1, die2,
      total: finalTotal,
      requiredRoll: phase.requiredRoll,
      success,
      message,
    });

    // m_007 Arctic Aries — successful hero roll: owner may DRAW a card.
    if (success) triggerSlainMonsterPassive(gameState, phase.rollingPlayerId, 'ON_HERO_ABILITY_SUCCESS');

    const player = gameState.players[phase.rollingPlayerId];
    const hero = player?.zones.party.find(c => c.instanceId === phase.heroInstanceId);
    if (player && hero) {
      const equippedItemId = hero.equippedItem;
      if (equippedItemId) {
        const itemInstance = player.zones.party.find(c => c.instanceId === equippedItemId);
        if (itemInstance) {
          const itemTemplate = gameState.cardTemplates[itemInstance.templateId];
          if (itemTemplate) {
            const itemTrigger = itemTemplate.trigger;
            if (itemTrigger?.scope === 'equipped_hero') {
              if (!success && itemTrigger.event === 'ON_HERO_ROLL_FAIL') {
                if (emitItemTriggerPrompt(rollingSocket, gameState, player, hero, itemInstance, itemTemplate, sendRoomUpdate)) return;
              }
              if (success && itemTrigger.event === 'ON_HERO_ROLL_SUCCESS') {
                if (emitItemTriggerPrompt(rollingSocket, gameState, player, hero, itemInstance, itemTemplate, sendRoomUpdate)) return;
              }
            }
          }
        }
      }
    }
  }

  sendRoomUpdate();
};

const advanceModifierQueue = (
  roomCode: string,
  phase: ModifierPhaseState,
  gameState: GameState,
  sendRoomUpdate: () => void
) => {
  phase.opponentQueue.shift();

  if (phase.opponentQueue.length > 0) {
    updateModifierPhaseGameState(roomCode, phase, gameState);
    sendRoomUpdate();
    return;
  }

  if (phase.cardPlayedThisCycle) {
    // A card was played this lap, so the roll is still contested — go around
    // again. The roller joins the rotation (after the opponents) so they can
    // respond to modifiers played against them; the loop ends only when a full
    // lap passes with no card played.
    const pool = [...phase.allOpponentsWithModifiers, phase.rollingPlayerId];
    const newQueue = pool.filter(
      pid => gameState.players[pid]?.zones.hand.some(c => c.cardType === 'modifier')
    );
    if (newQueue.length === 0) {
      finalizeRoll(roomCode, phase, gameState, sendRoomUpdate);
    } else {
      phase.opponentQueue = newQueue;
      phase.cardPlayedThisCycle = false;
      updateModifierPhaseGameState(roomCode, phase, gameState);
      sendRoomUpdate();
    }
  } else {
    finalizeRoll(roomCode, phase, gameState, sendRoomUpdate);
  }
};

const executeRollAndEmit = (
  socket: Socket<ClientToServerEvents, ServerToClientEvents>,
  gameState: GameState,
  player: Player,
  hero: CardInstance,
  preRollBonus: number,
  sendRoomUpdate: () => void
) => {
  const template = gameState.cardTemplates[hero.templateId];
  const requiredRoll = (template?.rollToPlay as number | undefined) ?? 0;
  const [die1, die2] = roll2d6();
  const persistentBonus = getPlayerRollBonus(player) + preRollBonus
    + getPartyLeaderHeroAbilityBonus(gameState, pidOf(socket))
    + getSlainMonsterRollBonus(gameState, player, 'HERO_ABILITY_ROLLS');
  const rawDiceTotal = die1 + die2;
  const currentTotal = rawDiceTotal + persistentBonus;
  const roomCode = socket.data.roomCode as string;

  hero.effectUsedThisTurn = true;

  const opponentsWithModifiers = getOpponentsWithModifiers(gameState, pidOf(socket));
  const rollerHasModifiers = player.zones.hand.some(c => c.cardType === 'modifier');
  const rollerNeedsPrompt = currentTotal < requiredRoll && rollerHasModifiers;

  logGame(gameState, 'hero_roll', {
    heroTemplateId: hero.templateId,
    die1, die2, persistentBonus,
    total: currentTotal,
    requiredRoll,
    success: currentTotal >= requiredRoll,
    contested: rollerNeedsPrompt || opponentsWithModifiers.length > 0,
  }, pidOf(socket));

  if (!rollerNeedsPrompt && opponentsWithModifiers.length === 0) {
    const success = currentTotal >= requiredRoll;
    const message = `Rolled ${die1} + ${die2}${persistentBonus ? ` + ${persistentBonus}` : ''} = ${currentTotal}. ${success ? 'Success!' : 'Failed.'} (needed ${requiredRoll}).`;
    socket.emit('heroRollResult', { heroInstanceId: hero.instanceId, die1, die2, total: currentTotal, requiredRoll, success, message });

    // m_007 Arctic Aries — successful hero roll: owner may DRAW a card.
    if (success) triggerSlainMonsterPassive(gameState, pidOf(socket), 'ON_HERO_ABILITY_SUCCESS');

    const equippedItemId = hero.equippedItem;
    if (equippedItemId) {
      const itemInstance = player.zones.party.find(c => c.instanceId === equippedItemId);
      if (itemInstance) {
        const itemTemplate = gameState.cardTemplates[itemInstance.templateId];
        if (itemTemplate) {
          const itemTrigger = itemTemplate.trigger;
          if (itemTrigger?.scope === 'equipped_hero') {
            if (!success && itemTrigger.event === 'ON_HERO_ROLL_FAIL') {
              if (emitItemTriggerPrompt(socket, gameState, player, hero, itemInstance, itemTemplate, sendRoomUpdate)) return;
            }
            if (success && itemTrigger.event === 'ON_HERO_ROLL_SUCCESS') {
              if (emitItemTriggerPrompt(socket, gameState, player, hero, itemInstance, itemTemplate, sendRoomUpdate)) return;
            }
          }
        }
      }
    }
    sendRoomUpdate();
    return;
  }

  const initialPhase: 'roller_turn' | 'opponent_turn' = rollerNeedsPrompt ? 'roller_turn' : 'opponent_turn';
  const phaseState: ModifierPhaseState = {
    die1, die2, rawDiceTotal, persistentBonus,
    accumulatedModifier: 0, requiredRoll,
    rollContext: 'HERO_ABILITY',
    rollType: 'hero_ability',
    heroInstanceId: hero.instanceId, rollingPlayerId: pidOf(socket),
    phase: initialPhase,
    allOpponentsWithModifiers: opponentsWithModifiers,
    opponentQueue: [...opponentsWithModifiers],
    cardPlayedThisCycle: false, modifiersPlayed: [],
  };

  const success = currentTotal >= requiredRoll;
  const statusWord = success ? 'Succeeding…' : 'Failing…';
  const message = `Rolled ${die1} + ${die2}${persistentBonus ? ` + ${persistentBonus}` : ''} = ${currentTotal}. ${statusWord} (needed ${requiredRoll}).`;
  socket.emit('heroRollResult', { heroInstanceId: hero.instanceId, die1, die2, total: currentTotal, requiredRoll, success, message });

  modifierPhases.set(roomCode, phaseState);
  updateModifierPhaseGameState(roomCode, phaseState, gameState);
  sendRoomUpdate();
};
export type { RollContextTag };
export {
  getPartyLeaderHeroAbilityBonus, getSlainMonsterRollBonus, getSlainOpponentModifierBonus,
  getOpponentsWithModifiers, getModifierAmount, getModifierChoiceLabel, modifierDiscardsHand,
  updateModifierPhaseGameState, finalizeRoll, advanceModifierQueue, executeRollAndEmit,
};

