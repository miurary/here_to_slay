// promptResponse.ts — extracted from the original monolithic server.ts.
import type {
  ClientToServerEvents, ServerToClientEvents,
  CardInstance, CardTemplate, Effect, GameState, Player, MonsterInstance, PlayerState,
} from '../../shared/src/types.js';
import type { Socket } from 'socket.io';
import {
  abilityPromptRequests, getRoomState, emitAbilityPrompt, emitAbilityResolution, buildPromptId,
} from './state.js';
import type { AbilityPromptOption } from './state.js';
import { getPlayerBySocketId, findHeroInPlayerParty, moveCardBetweenZones } from './util.js';
import { drawCards } from './cards.js';
import { processHeroAbilityEffects, tryDecoyDollRedirect, triggerSlainMonsterPassive } from './effects.js';
import { processMagicCardSteps, handleMagicPromptResponse } from './magic.js';
import { handleItemTriggerResponse } from './items.js';
import { promptMonsterSacrifice } from './monsters.js';
import { executeRollAndEmit } from './rolls.js';
import { triggerEndTurn } from './turns.js';


// Resolves a 'multiSelectCard' prompt where the player picks 0..N options before
// confirming. Currently used by i_004 (discard up to 3 cards for a roll bonus).
const handleMultiPromptResponse = (
  sourceSocket: Socket<ClientToServerEvents, ServerToClientEvents>,
  promptId: string,
  selectedOptionIds: string[],
  sendRoomUpdate: () => void
) => {
  const request = abilityPromptRequests.get(promptId);
  if (!request) {
    sourceSocket.emit('actionFailed', 'Prompt request not found.');
    return;
  }
  const gameState = getRoomState(sourceSocket.data.roomCode as string);
  if (!gameState) return;

  const sourcePlayer = getPlayerBySocketId(gameState, request.sourcePlayerId);
  if (!sourcePlayer) {
    sourceSocket.emit('actionFailed', 'Ability source player not found.');
    return;
  }

  // De-dupe and keep only ids that are valid options on this prompt.
  const validIds = new Set(request.options.map((o) => o.id));
  const chosen = [...new Set(selectedOptionIds)].filter((id) => validIds.has(id));

  const min = request.minSelections ?? 0;
  const max = request.maxSelections ?? request.options.length;
  if (chosen.length < min || chosen.length > max) {
    sourceSocket.emit('actionFailed', `Select between ${min} and ${max} card(s).`);
    return;
  }

  abilityPromptRequests.delete(promptId);

  if (request.effect.action === 'ITEM_I004_DISCARD_SELECT') {
    const sourceHero = findHeroInPlayerParty(sourcePlayer, request.heroInstanceId);
    if (!sourceHero) {
      sourceSocket.emit('actionFailed', 'Source hero not found when resolving prompt.');
      return;
    }
    const bonusPerCard = (request.effect.bonusPerCard as number | undefined) ?? 2;
    let discarded = 0;
    for (const optionId of chosen) {
      const option = request.options.find((o) => o.id === optionId);
      const cardInstanceId = option?.payload?.cardInstanceId;
      if (!cardInstanceId) continue;
      const idx = sourcePlayer.zones.hand.findIndex((c) => c.instanceId === cardInstanceId);
      if (idx !== -1) {
        const [card] = sourcePlayer.zones.hand.splice(idx, 1);
        if (card) {
          gameState.discardPile.push(card);
          discarded += 1;
        }
      }
    }
    executeRollAndEmit(sourceSocket, gameState, sourcePlayer, sourceHero, discarded * bonusPerCard, sendRoomUpdate);
    return;
  }

  if (request.effect.action === 'MAGIC_DISCARD_FOR_SACRIFICE') {
    // Lightning Labrys: discard the chosen cards; each one forces one sacrifice.
    let discarded = 0;
    for (const optionId of chosen) {
      const option = request.options.find((o) => o.id === optionId);
      const cardInstanceId = option?.payload?.cardInstanceId;
      if (!cardInstanceId) continue;
      const idx = sourcePlayer.zones.hand.findIndex((c) => c.instanceId === cardInstanceId);
      if (idx !== -1) {
        const [card] = sourcePlayer.zones.hand.splice(idx, 1);
        if (card) { gameState.discardPile.push(card); discarded += 1; }
      }
    }
    if (discarded > 0) {
      const sacrificeSteps: Effect[] = Array.from({ length: discarded }, () => ({ action: 'SACRIFICE_ANY_HERO' }));
      processMagicCardSteps(sourceSocket, gameState, sourcePlayer, request.heroInstanceId, sacrificeSteps, undefined);
    }
    sendRoomUpdate();
    return;
  }

  // Shared tail for hero-ability multi prompts: if nothing else is pending for
  // this hero, mark its effect used (mirrors handlePromptResponse's tail).
  const finishHeroMultiPrompt = () => {
    const pending = Array.from(abilityPromptRequests.values()).filter(
      (req) => req.heroInstanceId === request.heroInstanceId && req.sourcePlayerId === request.sourcePlayerId
    );
    if (pending.length === 0) {
      const sourceHero = findHeroInPlayerParty(sourcePlayer, request.heroInstanceId);
      if (sourceHero) sourceHero.effectUsedThisTurn = true;
    }
    sendRoomUpdate();
  };

  if (request.effect.action === 'HERO_MULTI_CHAIN_RESOLVE') {
    // h_028 Qi Bear (discard up to 3 → destroy per card) and
    // h_055 Rabid Beast (sacrifice any number → destroy per card).
    const removalMode = request.effect.removalMode as string | undefined;
    let removed = 0;
    for (const optionId of chosen) {
      const option = request.options.find((o) => o.id === optionId);
      const cardInstanceId = option?.payload?.cardInstanceId;
      if (!cardInstanceId) continue;
      if (removalMode === 'sacrifice') {
        const idx = sourcePlayer.zones.party.findIndex((c) => c.instanceId === cardInstanceId);
        if (idx === -1) continue;
        const card = sourcePlayer.zones.party[idx]!;
        // i_011 Decoy Doll absorbs a hero's sacrifice but still counts as the card given up.
        if (card.cardType === 'hero' && tryDecoyDollRedirect(gameState, sourcePlayer, cardInstanceId)) {
          removed += 1;
          continue;
        }
        sourcePlayer.zones.party.splice(idx, 1);
        gameState.discardPile.push(card);
        if (card.cardType === 'hero' && card.equippedItem) {
          const itemIdx = sourcePlayer.zones.party.findIndex((c) => c.instanceId === card.equippedItem);
          if (itemIdx !== -1) {
            const [item] = sourcePlayer.zones.party.splice(itemIdx, 1);
            if (item) gameState.discardPile.push(item);
          }
        }
        if (card.cardType === 'item') {
          const attachedHero = sourcePlayer.zones.party.find((c) => c.equippedItem === card.instanceId);
          if (attachedHero) delete attachedHero.equippedItem;
        }
        triggerSlainMonsterPassive(gameState, sourcePlayer.id, 'ON_SACRIFICE');
        removed += 1;
      } else {
        const idx = sourcePlayer.zones.hand.findIndex((c) => c.instanceId === cardInstanceId);
        if (idx !== -1) {
          const [card] = sourcePlayer.zones.hand.splice(idx, 1);
          if (card) { gameState.discardPile.push(card); removed += 1; }
        }
      }
    }
    const followUp = request.effect.followUpAction as string | undefined;
    const sourceHero = findHeroInPlayerParty(sourcePlayer, request.heroInstanceId);
    const heroTemplate = sourceHero ? gameState.cardTemplates[sourceHero.templateId] : undefined;
    if (removed > 0 && followUp && sourceHero && heroTemplate) {
      const followUpEffects: Effect[] = Array.from({ length: removed }, () => ({ action: followUp }));
      processHeroAbilityEffects(sourceSocket, gameState, sourcePlayer, sourceHero, heroTemplate, followUpEffects, undefined, sendRoomUpdate);
    }
    finishHeroMultiPrompt();
    return;
  }

  if (request.effect.action === 'HERO_TAKE_DISCARD_MULTI') {
    // h_020 Boston Terror: the asked player declined — take up to 2 from discard.
    for (const optionId of chosen) {
      const option = request.options.find((o) => o.id === optionId);
      const cardInstanceId = option?.payload?.cardInstanceId;
      if (!cardInstanceId) continue;
      const idx = gameState.discardPile.findIndex((c) => c.instanceId === cardInstanceId);
      if (idx !== -1) {
        const [card] = gameState.discardPile.splice(idx, 1);
        if (card) sourcePlayer.zones.hand.push(card);
      }
    }
    finishHeroMultiPrompt();
    return;
  }

  sendRoomUpdate();
};

const handlePromptResponse = (
  sourceSocket: Socket<ClientToServerEvents, ServerToClientEvents>,
  promptId: string,
  selectedOptionId: string,
  sendRoomUpdate: () => void
) => {
  const request = abilityPromptRequests.get(promptId);
  if (!request) {
    sourceSocket.emit('actionFailed', 'Prompt request not found.');
    return;
  }

  const gameState = getRoomState(sourceSocket.data.roomCode as string);
  if (!gameState) return;

  const player = getPlayerBySocketId(gameState, sourceSocket.id);
  if (!player) return;

  const option = request.options.find((opt) => opt.id === selectedOptionId);
  if (!option) {
    sourceSocket.emit('actionFailed', 'Invalid prompt option.');
    return;
  }

  abilityPromptRequests.delete(promptId);

  const responsePayload = option.payload as { playerId?: string; cardInstanceId?: string; [key: string]: unknown } | undefined;
  const sourcePlayer = getPlayerBySocketId(gameState, request.sourcePlayerId);
  if (!sourcePlayer) {
    sourceSocket.emit('actionFailed', 'Ability source player not found.');
    return;
  }

  const sourceHero = findHeroInPlayerParty(sourcePlayer, request.heroInstanceId);

  if (request.isMagicCard) {
    handleMagicPromptResponse(sourceSocket, gameState, sourcePlayer, request, responsePayload, sendRoomUpdate);
    return;
  }

  if (request.isMonsterEffect) {
    const roomCode = sourceSocket.data.roomCode as string;
    switch (request.effect.action) {
      case 'MONSTER_DISCARD': {
        const cardId = responsePayload?.cardInstanceId;
        if (cardId) {
          const idx = sourcePlayer.zones.hand.findIndex(c => c.instanceId === cardId);
          if (idx !== -1) {
            const [card] = sourcePlayer.zones.hand.splice(idx, 1);
            if (card) gameState.discardPile.push(card);
          }
        }
        const remaining = (request.effect.remaining as number) - 1;
        if (remaining > 0 && sourcePlayer.zones.hand.length > 0) {
          const opts = sourcePlayer.zones.hand.map(c => ({
            id: c.instanceId,
            label: gameState.cardTemplates[c.templateId]?.name || c.templateId,
            payload: { cardInstanceId: c.instanceId },
          }));
          emitAbilityPrompt(sourceSocket.id, {
            promptId: buildPromptId(),
            roomCode,
            heroInstanceId: request.heroInstanceId,
            sourcePlayerId: request.sourcePlayerId,
            promptType: 'discardCard',
            message: `Discard ${remaining} more card${remaining > 1 ? 's' : ''} (monster penalty).`,
            options: opts,
            effect: { ...request.effect, remaining },
            remainingEffects: [],
            isMonsterEffect: true,
          });
          sendRoomUpdate();
          return;
        }
        sendRoomUpdate();
        return;
      }
      case 'MONSTER_SACRIFICE_HERO': {
        const cardId = responsePayload?.cardInstanceId;
        // i_011 Decoy Doll absorbs this sacrifice (the hero survives), but it still
        // counts toward the required number — so only remove the hero when not redirected.
        if (cardId && !tryDecoyDollRedirect(gameState, sourcePlayer, cardId)) {
          const heroIdx = sourcePlayer.zones.party.findIndex(c => c.instanceId === cardId);
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
        // Repeat the prompt if more heroes must be sacrificed (e.g. m_013 Reptilian Ripper).
        const remaining = ((request.effect.remaining as number | undefined) ?? 1) - 1;
        if (remaining > 0 && sourcePlayer.zones.party.some(c => c.cardType === 'hero')) {
          promptMonsterSacrifice(
            sourceSocket, gameState, sourcePlayer, request.heroInstanceId,
            (request.effect.monsterName as string | undefined) ?? '',
            (request.effect.finalRoll as number | undefined) ?? 0,
            (request.effect.effectText as string | undefined) ?? '',
            remaining, sendRoomUpdate,
          );
          return;
        }
        sendRoomUpdate();
        return;
      }
      default:
        sendRoomUpdate();
        return;
    }
  }

  if (request.isPartyLeaderAbility) {
    if (request.effect.action === 'STEAL_CARD') {
      const targetPlayerId = responsePayload?.playerId;
      if (targetPlayerId) {
        const targetPlayer = gameState.players[targetPlayerId];
        if (targetPlayer && targetPlayer.zones.hand.length > 0) {
          const randomIdx = Math.floor(Math.random() * targetPlayer.zones.hand.length);
          const [stolenCard] = targetPlayer.zones.hand.splice(randomIdx, 1);
          if (stolenCard) sourcePlayer.zones.hand.push(stolenCard);
        }
      }
    } else if (request.effect.action === 'SEARCH_DISCARD') {
      const cardInstanceId = responsePayload?.cardInstanceId;
      if (cardInstanceId) {
        const idx = gameState.discardPile.findIndex(c => c.instanceId === cardInstanceId);
        if (idx !== -1) {
          const [card] = gameState.discardPile.splice(idx, 1);
          if (card) sourcePlayer.zones.hand.push(card);
        }
      }
    }
    const partyLeaderCard = sourcePlayer.zones.party.find(c => c.cardType === 'party_leader');
    if (partyLeaderCard) partyLeaderCard.effectUsedThisTurn = true;
    sendRoomUpdate();
    return;
  }

  if (request.isSlainPassive) {
    if (request.effect.action === 'SLAIN_PICK_FROM_DISCARD') {
      // m_001 Doombringer: move the chosen discard-pile card to hand (or skip).
      const cardInstanceId = responsePayload?.cardInstanceId;
      if (cardInstanceId) {
        const idx = gameState.discardPile.findIndex(c => c.instanceId === cardInstanceId);
        if (idx !== -1) {
          const [card] = gameState.discardPile.splice(idx, 1);
          if (card) sourcePlayer.zones.hand.push(card);
        }
      }
    } else if (request.effect.action === 'SLAIN_DRAW_EXTRA') {
      // m_005 Rex Major / m_006 Crowned Serpent / m_007 Arctic Aries / m_011 Dracos:
      // draw one extra card (the extra draw does not re-trigger).
      if (option.id === 'yes' && gameState.mainDeck.length > 0) {
        sourcePlayer.zones.hand.push(...drawCards(gameState.mainDeck, 1));
      }
    } else if (request.effect.action === 'SLAIN_FORCE_DISCARD') {
      // m_009 Bloodwing: the challenger discards the chosen card from their hand.
      const cardInstanceId = responsePayload?.cardInstanceId;
      if (cardInstanceId) moveCardBetweenZones(sourcePlayer.zones.hand, gameState.discardPile, cardInstanceId);
    } else if (request.effect.action === 'SLAIN_PLAY_MAGIC') {
      // m_008 Orthus: play the just-drawn Magic card immediately (resolves at once).
      if (option.id === 'yes') {
        const cardId = request.effect.cardInstanceId as string | undefined;
        const idx = cardId ? sourcePlayer.zones.hand.findIndex(c => c.instanceId === cardId) : -1;
        if (idx !== -1) {
          const [magicCard] = sourcePlayer.zones.hand.splice(idx, 1);
          if (magicCard) {
            gameState.discardPile.push(magicCard);
            const template = gameState.cardTemplates[magicCard.templateId];
            if (template?.effect) {
              const steps: Effect[] = template.effect.steps ?? [template.effect as unknown as Effect];
              processMagicCardSteps(sourceSocket, gameState, sourcePlayer, magicCard.instanceId, steps, undefined, true);
            }
          }
        }
      }
    } else if (request.effect.action === 'SLAIN_PLAY_ITEM') {
      // m_010 Malamammoth: equip the just-drawn Item card to the chosen hero.
      const targetHeroId = responsePayload?.cardInstanceId;
      const itemId = request.effect.itemInstanceId as string | undefined;
      if (option.id !== 'skip' && targetHeroId && itemId) {
        const targetHero = sourcePlayer.zones.party.find(c => c.instanceId === targetHeroId && c.cardType === 'hero');
        const itemIdx = sourcePlayer.zones.hand.findIndex(c => c.instanceId === itemId);
        if (targetHero && !targetHero.equippedItem && itemIdx !== -1) {
          const [itemCard] = sourcePlayer.zones.hand.splice(itemIdx, 1);
          if (itemCard) {
            sourcePlayer.zones.party.push(itemCard);
            targetHero.equippedItem = itemCard.instanceId;
          }
        }
      }
    }
    sendRoomUpdate();
    return;
  }

  if (!sourceHero) {
    sourceSocket.emit('actionFailed', 'Source hero not found when resolving prompt.');
    return;
  }

  if (request.isItemTrigger) {
    handleItemTriggerResponse(sourceSocket, gameState, sourcePlayer, sourceHero, request, option, responsePayload, sendRoomUpdate);
    return;
  }

  const template = gameState.cardTemplates[sourceHero.templateId];
  if (!template || !template.activeSkill || !Array.isArray(template.activeSkill.effects)) {
    sourceSocket.emit('actionFailed', 'Hero ability could not be resolved.');
    return;
  }

  const result = processHeroAbilityEffects(sourceSocket, gameState, player, sourceHero, template, [request.effect], responsePayload, sendRoomUpdate);

  let remainingResult: string | undefined;
  if (request.remainingEffects.length > 0) {
    // Pass playerId from the response payload so chained effects like STEAL_RANDOM_CARD
    // target_owner can access who owns the card that was just selected.
    const remainingPayload = responsePayload?.playerId ? { playerId: responsePayload.playerId } : undefined;
    remainingResult = processHeroAbilityEffects(sourceSocket, gameState, sourcePlayer, sourceHero, template, request.remainingEffects, remainingPayload, sendRoomUpdate) ?? undefined;
  }

  const combinedResult = [result, remainingResult].filter(Boolean).join(' ') || undefined;

  const pendingPrompts = Array.from(abilityPromptRequests.values()).filter(
    (req) => req.heroInstanceId === sourceHero.instanceId && req.sourcePlayerId === request.sourcePlayerId
  );

  if (pendingPrompts.length === 0) {
    sourceHero.effectUsedThisTurn = true;
    if (combinedResult) {
      emitAbilityResolution(sourceSocket, sourceHero.instanceId, combinedResult);
    }
    const forcedTurnPlayerId = gameState.forceEndTurn;
    if (forcedTurnPlayerId) {
      triggerEndTurn(forcedTurnPlayerId, gameState, sourceSocket.data.roomCode as string, sendRoomUpdate);
      return;
    }
  }

  const isDiscardPrompt = request.effect.action === 'PROMPT_DISCARD';
  const discardAmount = typeof request.effect.amount === 'number' ? request.effect.amount : 1;
  const shouldRepeatDiscard = isDiscardPrompt && responsePayload?.cardInstanceId && discardAmount > 1;
  if (shouldRepeatDiscard) {
    const remainingAmount = discardAmount - 1;
    const nextEffect = { ...request.effect, amount: remainingAmount };
    const options = player.zones.hand.map((card) => ({
      id: card.instanceId,
      label: gameState.cardTemplates[card.templateId]?.name || card.templateId,
      payload: { cardInstanceId: card.instanceId },
    }));

    if (options.length === 0) {
      emitAbilityResolution(sourceSocket, sourceHero.instanceId, 'No more cards available to discard.');
      sendRoomUpdate();
      return;
    }

    const promptId = buildPromptId();
    abilityPromptRequests.set(promptId, {
      promptId,
      roomCode: request.roomCode,
      heroInstanceId: request.heroInstanceId,
      sourcePlayerId: request.sourcePlayerId,
      promptType: 'discardCard',
      message: `Discard ${remainingAmount} card${remainingAmount === 1 ? '' : 's'}.`,
      options,
      effect: nextEffect,
      remainingEffects: [],
    });

    sourceSocket.emit('abilityPrompt', {
      promptId,
      heroInstanceId: request.heroInstanceId,
      promptType: 'discardCard',
      message: `Discard ${remainingAmount} card${remainingAmount === 1 ? '' : 's'}.`,
      options,
      requesterId: request.sourcePlayerId,
    });
  }

  sendRoomUpdate();
};
export { handlePromptResponse, handleMultiPromptResponse };

