// items.ts — extracted from the original monolithic server.ts.
import type {
  ClientToServerEvents, ServerToClientEvents,
  CardInstance, CardTemplate, GameState, Player,
} from '../../shared/src/types.js';
import type { Socket } from 'socket.io';
import { emitAbilityPrompt, buildPromptId, pidOf } from './state.js';
import type { AbilityPromptRequest, AbilityPromptOption } from './state.js';
import { drawCardsForPlayer, triggerSlainMonsterPassive, tryDecoyDollRedirect } from './effects.js';
import { executeRollAndEmit } from './rolls.js';


const emitItemTriggerPrompt = (
  socket: Socket<ClientToServerEvents, ServerToClientEvents>,
  gameState: GameState,
  player: Player,
  hero: CardInstance,
  itemInstance: CardInstance,
  itemTemplate: CardTemplate,
  sendRoomUpdate: () => void
): boolean => {
  const trigger = itemTemplate.trigger;
  if (!trigger) return false;
  const effectAction = trigger.effects[0]?.action;
  if (!effectAction) return false;

  switch (effectAction) {
    case 'REROLL_HERO_ABILITY': {
      emitAbilityPrompt(pidOf(socket), {
        promptId: buildPromptId(),
        roomCode: socket.data.roomCode as string,
        heroInstanceId: hero.instanceId,
        sourcePlayerId: pidOf(socket),
        promptType: 'confirm',
        message: `${itemTemplate.name}: Sacrifice this item to reroll the hero ability?`,
        options: [
          { id: 'use', label: `Yes, sacrifice ${itemTemplate.name}` },
          { id: 'skip', label: 'No, skip' },
        ],
        effect: { action: 'ITEM_GOBLET_CONFIRM' },
        remainingEffects: [],
        isItemTrigger: true,
        itemInstanceId: itemInstance.instanceId,
      });
      sendRoomUpdate();
      return true;
    }
    case 'PROMPT_SACRIFICE_HERO': {
      const heroOptions = player.zones.party
        .filter((c: CardInstance) => c.cardType === 'hero')
        .map((c: CardInstance) => ({
          id: c.instanceId,
          label: gameState.cardTemplates[c.templateId]?.name || c.templateId,
          payload: { cardInstanceId: c.instanceId },
        }));
      if (heroOptions.length === 0) return false;
      emitAbilityPrompt(pidOf(socket), {
        promptId: buildPromptId(),
        roomCode: socket.data.roomCode as string,
        heroInstanceId: hero.instanceId,
        sourcePlayerId: pidOf(socket),
        promptType: 'selectCard',
        message: `${itemTemplate.name}: You must SACRIFICE a Hero card.`,
        options: heroOptions,
        effect: { action: 'ITEM_SACRIFICE_HERO' },
        remainingEffects: [],
        isItemTrigger: true,
        itemInstanceId: itemInstance.instanceId,
      });
      sendRoomUpdate();
      return true;
    }
    case 'DISCARD': {
      const cardOptions = player.zones.hand.map((c: CardInstance) => ({
        id: c.instanceId,
        label: gameState.cardTemplates[c.templateId]?.name || c.templateId,
        payload: { cardInstanceId: c.instanceId },
      }));
      if (cardOptions.length === 0) return false;
      emitAbilityPrompt(pidOf(socket), {
        promptId: buildPromptId(),
        roomCode: socket.data.roomCode as string,
        heroInstanceId: hero.instanceId,
        sourcePlayerId: pidOf(socket),
        promptType: 'discardCard',
        message: `${itemTemplate.name}: You must DISCARD a card.`,
        options: cardOptions,
        effect: { action: 'ITEM_COIN_DISCARD' },
        remainingEffects: [],
        isItemTrigger: true,
        itemInstanceId: itemInstance.instanceId,
      });
      sendRoomUpdate();
      return true;
    }
    case 'DRAW': {
      // i_010 Particularly Rusty Coin: automatic, no prompt — draw a card on a failed roll.
      drawCardsForPlayer(gameState, player, trigger.effects[0]?.amount ?? 1);
      return false;
    }
    case 'APPLY_ROLL_MODIFIER': {
      // i_012 Silver Lining: automatic — +N to all of your rolls for the rest of the turn.
      const modifiers = player.temporaryModifiers ?? [];
      modifiers.push({ modifierType: 'rollBonus', amount: trigger.effects[0]?.amount ?? 0, duration: 1 });
      player.temporaryModifiers = modifiers;
      return false;
    }
    default:
      return false;
  }
};

const handleItemTriggerResponse = (
  sourceSocket: Socket<ClientToServerEvents, ServerToClientEvents>,
  gameState: GameState,
  sourcePlayer: Player,
  sourceHero: CardInstance,
  request: AbilityPromptRequest,
  option: AbilityPromptOption,
  responsePayload: { playerId?: string; cardInstanceId?: string; [key: string]: unknown } | undefined,
  sendRoomUpdate: () => void
) => {
  switch (request.effect.action as string) {
    // i_004 "Biggest Ring Ever" is resolved via the multi-select prompt
    // (see handleMultiPromptResponse), not through this single-select handler.
    case 'ITEM_GOBLET_CONFIRM': {
      if (option.id === 'use' && request.itemInstanceId) {
        const itemIdx = sourcePlayer.zones.party.findIndex(c => c.instanceId === request.itemInstanceId);
        if (itemIdx !== -1) {
          const [item] = sourcePlayer.zones.party.splice(itemIdx, 1);
          if (item) gameState.discardPile.push(item);
        }
        delete sourceHero.equippedItem;
        executeRollAndEmit(sourceSocket, gameState, sourcePlayer, sourceHero, 0, sendRoomUpdate);
        return;
      }
      sendRoomUpdate();
      return;
    }
    case 'ITEM_SACRIFICE_HERO': {
      const cardInstanceId = responsePayload?.cardInstanceId;
      if (cardInstanceId) {
        // i_011 Decoy Doll — absorbs the sacrifice; the hero survives.
        if (tryDecoyDollRedirect(gameState, sourcePlayer, cardInstanceId)) {
          sendRoomUpdate();
          return;
        }
        const heroIdx = sourcePlayer.zones.party.findIndex(c => c.instanceId === cardInstanceId);
        if (heroIdx !== -1) {
          const [sacrificed] = sourcePlayer.zones.party.splice(heroIdx, 1);
          if (sacrificed) {
            gameState.discardPile.push(sacrificed);
            triggerSlainMonsterPassive(gameState, sourcePlayer.id, 'ON_SACRIFICE');
            if (sacrificed.equippedItem) {
              const itemIdx = sourcePlayer.zones.party.findIndex(c => c.instanceId === sacrificed.equippedItem);
              if (itemIdx !== -1) {
                const [item] = sourcePlayer.zones.party.splice(itemIdx, 1);
                if (item) gameState.discardPile.push(item);
              }
            }
          }
        }
      }
      sendRoomUpdate();
      return;
    }
    case 'ITEM_COIN_DISCARD': {
      const cardInstanceId = responsePayload?.cardInstanceId;
      if (cardInstanceId) {
        const idx = sourcePlayer.zones.hand.findIndex(c => c.instanceId === cardInstanceId);
        if (idx !== -1) {
          const [discarded] = sourcePlayer.zones.hand.splice(idx, 1);
          if (discarded) gameState.discardPile.push(discarded);
        }
      }
      sendRoomUpdate();
      return;
    }
    default:
      sendRoomUpdate();
  }
};
export { emitItemTriggerPrompt, handleItemTriggerResponse };

