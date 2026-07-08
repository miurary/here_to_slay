// magic.ts — extracted from the original monolithic server.ts.
import type {
  ClientToServerEvents, ServerToClientEvents,
  Effect, GameState, Player,
} from '../../shared/src/types.js';
import type { Socket } from 'socket.io';
import { emitAbilityPrompt, buildPromptId, pidOf } from './state.js';
import type { AbilityPromptOption, AbilityPromptRequest } from './state.js';
import { moveCardBetweenZones, playerHasSlainEffectAction, playerHasSlainEffectFlag, playerHasTempFlag } from './util.js';
import { drawCardsForPlayer, resolveHeroDestruction, triggerSlainMonsterPassive, tryDecoyDollRedirect } from './effects.js';


const processMagicCardSteps = (
  socket: Socket<ClientToServerEvents, ServerToClientEvents>,
  gameState: GameState,
  player: Player,
  magicCardId: string,
  steps: Effect[],
  responsePayload?: { playerId?: string; cardInstanceId?: string; [key: string]: unknown },
  isInitialPlay = false,
): string[] => {
  const messages: string[] = [];
  let promptCreated = false;

  // p_007 Cloaked Sage: draw 1 when you play a magic card. Only on the initial
  // play — chained continuations (from prompt responses) call this again and must
  // not re-trigger the draw.
  if (isInitialPlay && player.partyLeaderId) {
    const plTemplate = gameState.cardTemplates[player.partyLeaderId];
    if (plTemplate?.effect?.triggerEvent === 'ON_PLAY_MAGIC' && plTemplate.effect.action === 'DRAW') {
      drawCardsForPlayer(gameState, player, 1);
    }
  }

  for (let i = 0; i < steps.length; i++) {
    if (promptCreated) break;
    const step = steps[i];
    if (!step) continue;
    const remainingSteps = steps.slice(i + 1);
    let stepResult: string | undefined;

    switch (step.action) {
      case 'DRAW': {
        const drawn = drawCardsForPlayer(gameState, player, step.amount ?? 1);
        stepResult = `Drew ${drawn.length} card${drawn.length === 1 ? '' : 's'}.`;
        break;
      }
      case 'APPLY_ROLL_MODIFIER': {
        const modifiers = player.temporaryModifiers ?? [];
        modifiers.push({ modifierType: 'rollBonus', amount: step.amount ?? 0, duration: 1 });
        player.temporaryModifiers = modifiers;
        stepResult = `+${step.amount} to all rolls this turn.`;
        break;
      }
      case 'DISCARD': {
        if (responsePayload?.cardInstanceId) {
          const card = moveCardBetweenZones(player.zones.hand, gameState.discardPile, responsePayload.cardInstanceId);
          stepResult = card ? `Discarded ${gameState.cardTemplates[card.templateId]?.name || card.templateId}.` : 'Card not found.';
          break;
        }
        const discardOptions = player.zones.hand.map(c => ({
          id: c.instanceId,
          label: gameState.cardTemplates[c.templateId]?.name || c.templateId,
          payload: { cardInstanceId: c.instanceId },
        }));
        if (discardOptions.length === 0) { stepResult = 'No cards to discard.'; break; }
        emitAbilityPrompt(pidOf(socket), {
          promptId: buildPromptId(),
          roomCode: socket.data.roomCode as string,
          heroInstanceId: magicCardId,
          sourcePlayerId: pidOf(socket),
          promptType: 'discardCard',
          message: 'Discard a card.',
          options: discardOptions,
          effect: step,
          remainingEffects: remainingSteps,
          isMagicCard: true,
        });
        promptCreated = true;
        break;
      }
      case 'DESTROY_HERO': {
        if (responsePayload?.cardInstanceId) {
          const heroId = responsePayload.cardInstanceId as string;
          let ownerId = responsePayload.playerId as string | undefined;
          if (!ownerId) {
            for (const [opId, opp] of Object.entries(gameState.players)) {
              if (opId === pidOf(socket)) continue;
              if (opp.zones.party.some(c => c.instanceId === heroId)) { ownerId = opId; break; }
            }
          }
          if (!ownerId) { stepResult = 'Hero not found.'; break; }
          // m_012 Corrupted Sabretooth — the destroyer may STEAL the hero instead
          // (not offered when the owner's heroes can't be stolen — h_034).
          const sabreOwner = gameState.players[ownerId];
          if (
            playerHasSlainEffectAction(gameState, player, 'STEAL_INSTEAD_OF_DESTROY') &&
            sabreOwner && !playerHasTempFlag(sabreOwner, 'blockSteal')
          ) {
            const target = gameState.players[ownerId]?.zones.party.find(c => c.instanceId === heroId);
            const heroName = target ? gameState.cardTemplates[target.templateId]?.name ?? 'that Hero' : 'that Hero';
            emitAbilityPrompt(pidOf(socket), {
              promptId: buildPromptId(),
              roomCode: socket.data.roomCode as string,
              heroInstanceId: magicCardId,
              sourcePlayerId: pidOf(socket),
              promptType: 'confirm',
              message: `Corrupted Sabretooth: STEAL ${heroName} instead of destroying it?`,
              options: [
                { id: 'steal', label: `Steal ${heroName}`, payload: { choice: 'steal', cardInstanceId: heroId, playerId: ownerId } },
                { id: 'destroy', label: 'Destroy it', payload: { choice: 'destroy', cardInstanceId: heroId, playerId: ownerId } },
              ],
              effect: { action: 'SABRETOOTH_RESOLVE' },
              remainingEffects: remainingSteps,
              isMagicCard: true,
            });
            promptCreated = true;
            break;
          }
          stepResult = resolveHeroDestruction(gameState, ownerId, heroId);
          break;
        }
        const destroyOptions: AbilityPromptOption[] = [];
        for (const [opId, opp] of Object.entries(gameState.players)) {
          if (opId === pidOf(socket)) continue;
          // m_014 Terratuga / h_032 Mighty Blade — protected heroes are not targets.
          if (playerHasSlainEffectFlag(gameState, opp, 'blockHeroDestruction')) continue;
          if (playerHasTempFlag(opp, 'blockHeroDestruction')) continue;
          for (const card of opp.zones.party) {
            if (card.cardType === 'hero') {
              destroyOptions.push({
                id: card.instanceId,
                label: `${gameState.cardTemplates[card.templateId]?.name || card.templateId} (${opp.username || 'opponent'})`,
                payload: { cardInstanceId: card.instanceId, playerId: opId },
              });
            }
          }
        }
        if (destroyOptions.length === 0) { stepResult = 'No opponent heroes to destroy.'; break; }
        emitAbilityPrompt(pidOf(socket), {
          promptId: buildPromptId(),
          roomCode: socket.data.roomCode as string,
          heroInstanceId: magicCardId,
          sourcePlayerId: pidOf(socket),
          promptType: 'selectCard',
          message: 'Choose a Hero to DESTROY.',
          options: destroyOptions,
          effect: step,
          remainingEffects: remainingSteps,
          isMagicCard: true,
        });
        promptCreated = true;
        break;
      }
      case 'SABRETOOTH_RESOLVE': {
        // m_012 Corrupted Sabretooth: resolve the steal-or-destroy choice.
        const heroId = responsePayload?.cardInstanceId as string | undefined;
        const ownerId = responsePayload?.playerId as string | undefined;
        if (!heroId || !ownerId) { stepResult = 'Hero not found.'; break; }
        if (responsePayload?.choice === 'steal') {
          const owner = gameState.players[ownerId];
          const idx = owner?.zones.party.findIndex(c => c.instanceId === heroId) ?? -1;
          if (owner && idx !== -1) {
            const [hero] = owner.zones.party.splice(idx, 1);
            if (hero) {
              player.zones.party.push(hero);
              if (hero.equippedItem) {
                const itemIdx = owner.zones.party.findIndex(c => c.instanceId === hero.equippedItem);
                if (itemIdx !== -1) {
                  const [item] = owner.zones.party.splice(itemIdx, 1);
                  if (item) player.zones.party.push(item);
                }
              }
              stepResult = `Stole ${gameState.cardTemplates[hero.templateId]?.name || 'hero'}.`;
            }
          } else stepResult = 'Hero not found.';
        } else {
          stepResult = resolveHeroDestruction(gameState, ownerId, heroId);
        }
        break;
      }
      case 'STEAL': {
        if (responsePayload?.cardInstanceId && responsePayload?.playerId) {
          const opponentId = responsePayload.playerId as string;
          const opponent = gameState.players[opponentId];
          if (!opponent) { stepResult = 'Opponent not found.'; break; }
          // h_034 Calming Voice — that player's heroes cannot be stolen.
          if (playerHasTempFlag(opponent, 'blockSteal')) { stepResult = 'Those heroes cannot be stolen right now.'; break; }
          const card = moveCardBetweenZones(opponent.zones.party, player.zones.party, responsePayload.cardInstanceId);
          if (!card) { stepResult = 'Could not steal hero.'; break; }
          if (card.equippedItem) moveCardBetweenZones(opponent.zones.party, player.zones.party, card.equippedItem);
          stepResult = `Stole ${gameState.cardTemplates[card.templateId]?.name || 'hero'} from ${opponent.username || 'opponent'}.`;
          break;
        }
        const stealOptions: AbilityPromptOption[] = [];
        for (const [opId, opp] of Object.entries(gameState.players)) {
          if (opId === pidOf(socket)) continue;
          if (playerHasTempFlag(opp, 'blockSteal')) continue; // h_034 Calming Voice
          for (const card of opp.zones.party) {
            if (card.cardType === 'hero') {
              stealOptions.push({
                id: card.instanceId,
                label: `${gameState.cardTemplates[card.templateId]?.name || card.templateId} (${opp.username || 'opponent'})`,
                payload: { cardInstanceId: card.instanceId, playerId: opId },
              });
            }
          }
        }
        if (stealOptions.length === 0) { stepResult = 'No opponent heroes to steal.'; break; }
        emitAbilityPrompt(pidOf(socket), {
          promptId: buildPromptId(),
          roomCode: socket.data.roomCode as string,
          heroInstanceId: magicCardId,
          sourcePlayerId: pidOf(socket),
          promptType: 'selectCard',
          message: 'Choose a Hero to STEAL from an opponent.',
          options: stealOptions,
          effect: step,
          remainingEffects: remainingSteps,
          isMagicCard: true,
        });
        promptCreated = true;
        break;
      }
      case 'SWAP': {
        if (responsePayload?.cardInstanceId && responsePayload?.playerId) {
          const opponentId = responsePayload.playerId as string;
          const opponent = gameState.players[opponentId];
          if (!opponent) { stepResult = 'Opponent not found.'; break; }
          const card = moveCardBetweenZones(player.zones.party, opponent.zones.party, responsePayload.cardInstanceId);
          if (!card) { stepResult = 'Could not give hero.'; break; }
          if (card.equippedItem) moveCardBetweenZones(player.zones.party, opponent.zones.party, card.equippedItem);
          stepResult = `Gave ${gameState.cardTemplates[card.templateId]?.name || 'hero'} to opponent.`;
          break;
        }
        // Need opponentId from the chained STEAL response — it arrives in responsePayload.playerId
        const opponentId = responsePayload?.playerId as string | undefined;
        if (!opponentId) { stepResult = 'No target opponent for SWAP.'; break; }
        const swapOptions = player.zones.party
          .filter(c => c.cardType === 'hero')
          .map(c => ({
            id: c.instanceId,
            label: gameState.cardTemplates[c.templateId]?.name || c.templateId,
            // embed opponentId so the next response knows where to send the hero
            payload: { cardInstanceId: c.instanceId, playerId: opponentId },
          }));
        if (swapOptions.length === 0) { stepResult = 'No heroes to give.'; break; }
        emitAbilityPrompt(pidOf(socket), {
          promptId: buildPromptId(),
          roomCode: socket.data.roomCode as string,
          heroInstanceId: magicCardId,
          sourcePlayerId: pidOf(socket),
          promptType: 'selectCard',
          message: 'Choose a Hero from your Party to give to the opponent.',
          options: swapOptions,
          effect: step,
          remainingEffects: remainingSteps,
          isMagicCard: true,
        });
        promptCreated = true;
        break;
      }
      case 'DISCARD_HAND': {
        // Mass Sacrifice: discard the player's whole hand (no prompt).
        const n = player.zones.hand.length;
        if (n > 0) {
          gameState.discardPile.push(...player.zones.hand);
          player.zones.hand = [];
        }
        stepResult = `Discarded ${n} card${n === 1 ? '' : 's'}.`;
        break;
      }
      case 'RECOVER_HERO': {
        // Call to the Fallen: take a Hero card from the discard pile into hand.
        if (responsePayload?.cardInstanceId) {
          const idx = gameState.discardPile.findIndex(c => c.instanceId === responsePayload.cardInstanceId);
          if (idx !== -1) {
            const [card] = gameState.discardPile.splice(idx, 1);
            if (card) {
              player.zones.hand.push(card);
              stepResult = `Recovered ${gameState.cardTemplates[card.templateId]?.name || 'a Hero'} from the discard pile.`;
            }
          } else stepResult = 'Card not found.';
          break;
        }
        const heroOptions = gameState.discardPile
          .filter(c => c.cardType === 'hero')
          .map(c => ({
            id: c.instanceId,
            label: gameState.cardTemplates[c.templateId]?.name || c.templateId,
            payload: { cardInstanceId: c.instanceId },
          }));
        if (heroOptions.length === 0) { stepResult = 'No Hero cards in the discard pile.'; break; }
        emitAbilityPrompt(pidOf(socket), {
          promptId: buildPromptId(),
          roomCode: socket.data.roomCode as string,
          heroInstanceId: magicCardId,
          sourcePlayerId: pidOf(socket),
          promptType: 'selectCard',
          message: 'Choose a Hero card from the discard pile to add to your hand.',
          options: heroOptions,
          effect: step,
          remainingEffects: remainingSteps,
          isMagicCard: true,
        });
        promptCreated = true;
        break;
      }
      case 'RETURN_ITEM': {
        // Winds of Change: return one equipped Item to its owner's hand.
        if (responsePayload?.cardInstanceId && responsePayload?.playerId) {
          const owner = gameState.players[responsePayload.playerId as string];
          const itemId = responsePayload.cardInstanceId as string;
          if (owner) {
            const idx = owner.zones.party.findIndex(c => c.instanceId === itemId);
            if (idx !== -1) {
              const [item] = owner.zones.party.splice(idx, 1);
              if (item) {
                const equippedHero = owner.zones.party.find(h => h.equippedItem === itemId);
                if (equippedHero) delete equippedHero.equippedItem;
                owner.zones.hand.push(item);
                stepResult = `Returned ${gameState.cardTemplates[item.templateId]?.name || 'an item'} to ${owner.username || 'its owner'}'s hand.`;
              }
            }
          }
          break;
        }
        const itemOptions: AbilityPromptOption[] = [];
        for (const [pid, p] of Object.entries(gameState.players)) {
          for (const card of p.zones.party) {
            if (card.cardType === 'item') {
              itemOptions.push({
                id: card.instanceId,
                label: `${gameState.cardTemplates[card.templateId]?.name || card.templateId} (${p.username || 'player'})`,
                payload: { cardInstanceId: card.instanceId, playerId: pid },
              });
            }
          }
        }
        if (itemOptions.length === 0) { stepResult = 'No equipped items in play.'; break; }
        emitAbilityPrompt(pidOf(socket), {
          promptId: buildPromptId(),
          roomCode: socket.data.roomCode as string,
          heroInstanceId: magicCardId,
          sourcePlayerId: pidOf(socket),
          promptType: 'selectCard',
          message: 'Choose an equipped Item to return to its owner’s hand.',
          options: itemOptions,
          effect: step,
          remainingEffects: remainingSteps,
          isMagicCard: true,
        });
        promptCreated = true;
        break;
      }
      case 'RETURN_ALL_ITEMS': {
        // Forceful Winds: return every equipped Item to its owner's hand (no prompt).
        let count = 0;
        for (const p of Object.values(gameState.players)) {
          const itemIds = p.zones.party.filter(c => c.cardType === 'item').map(c => c.instanceId);
          if (itemIds.length === 0) continue;
          for (const hero of p.zones.party) {
            if (hero.equippedItem && itemIds.includes(hero.equippedItem)) delete hero.equippedItem;
          }
          const items = p.zones.party.filter(c => itemIds.includes(c.instanceId));
          p.zones.party = p.zones.party.filter(c => !itemIds.includes(c.instanceId));
          p.zones.hand.push(...items);
          count += items.length;
        }
        stepResult = `Returned ${count} equipped item${count === 1 ? '' : 's'} to ${count === 1 ? 'its owner' : 'their owners'}.`;
        break;
      }
      case 'DISCARD_FOR_SACRIFICE': {
        // Lightning Labrys: discard up to N cards; each forces a player to sacrifice a Hero.
        if (player.zones.hand.length === 0) { stepResult = 'No cards to discard.'; break; }
        const maxN = Math.min(step.amount ?? 3, player.zones.hand.length);
        const options = player.zones.hand.map(c => ({
          id: c.instanceId,
          label: gameState.cardTemplates[c.templateId]?.name || c.templateId,
          payload: { cardInstanceId: c.instanceId },
        }));
        emitAbilityPrompt(pidOf(socket), {
          promptId: buildPromptId(),
          roomCode: socket.data.roomCode as string,
          heroInstanceId: magicCardId,
          sourcePlayerId: pidOf(socket),
          promptType: 'multiSelectCard',
          message: `Discard up to ${maxN} card${maxN === 1 ? '' : 's'} — each forces a player to SACRIFICE a Hero.`,
          options,
          minSelections: 0,
          maxSelections: maxN,
          effect: { action: 'MAGIC_DISCARD_FOR_SACRIFICE' },
          remainingEffects: remainingSteps,
          isMagicCard: true,
        });
        promptCreated = true;
        break;
      }
      case 'SACRIFICE_ANY_HERO': {
        // One forced sacrifice: the caster designates a Hero in any party to be sacrificed.
        if (responsePayload?.cardInstanceId && responsePayload?.playerId) {
          const owner = gameState.players[responsePayload.playerId as string];
          const heroId = responsePayload.cardInstanceId as string;
          if (owner) {
            // i_011 Decoy Doll — absorbs the sacrifice; the hero survives.
            if (tryDecoyDollRedirect(gameState, owner, heroId)) {
              stepResult = `A Decoy Doll protected ${owner.username || 'a player'}'s Hero.`;
              break;
            }
            const idx = owner.zones.party.findIndex(c => c.instanceId === heroId && c.cardType === 'hero');
            if (idx !== -1) {
              const [hero] = owner.zones.party.splice(idx, 1);
              if (hero) {
                gameState.discardPile.push(hero);
                if (hero.equippedItem) {
                  const itemIdx = owner.zones.party.findIndex(c => c.instanceId === hero.equippedItem);
                  if (itemIdx !== -1) {
                    const [item] = owner.zones.party.splice(itemIdx, 1);
                    if (item) gameState.discardPile.push(item);
                  }
                }
                triggerSlainMonsterPassive(gameState, owner.id, 'ON_SACRIFICE');
                stepResult = `${owner.username || 'A player'} sacrificed ${gameState.cardTemplates[hero.templateId]?.name || 'a Hero'}.`;
              }
            }
          }
          break;
        }
        const sacOptions: AbilityPromptOption[] = [];
        for (const [pid, p] of Object.entries(gameState.players)) {
          for (const card of p.zones.party) {
            if (card.cardType === 'hero') {
              sacOptions.push({
                id: card.instanceId,
                label: `${gameState.cardTemplates[card.templateId]?.name || card.templateId} (${p.username || 'player'})`,
                payload: { cardInstanceId: card.instanceId, playerId: pid },
              });
            }
          }
        }
        if (sacOptions.length === 0) { stepResult = 'No Heroes available to sacrifice.'; break; }
        emitAbilityPrompt(pidOf(socket), {
          promptId: buildPromptId(),
          roomCode: socket.data.roomCode as string,
          heroInstanceId: magicCardId,
          sourcePlayerId: pidOf(socket),
          promptType: 'selectCard',
          message: 'Choose a Hero card to SACRIFICE.',
          options: sacOptions,
          effect: step,
          remainingEffects: remainingSteps,
          isMagicCard: true,
        });
        promptCreated = true;
        break;
      }
      default:
        stepResult = `Unsupported magic action: ${step.action as string}`;
        break;
    }

    if (stepResult !== undefined) messages.push(stepResult);
  }

  return messages;
};

const handleMagicPromptResponse = (
  sourceSocket: Socket<ClientToServerEvents, ServerToClientEvents>,
  gameState: GameState,
  sourcePlayer: Player,
  request: AbilityPromptRequest,
  responsePayload: { playerId?: string; cardInstanceId?: string; [key: string]: unknown } | undefined,
  sendRoomUpdate: () => void
) => {
  processMagicCardSteps(sourceSocket, gameState, sourcePlayer, request.heroInstanceId, [request.effect], responsePayload);

  if (request.remainingEffects.length > 0) {
    const chainPayload = responsePayload?.playerId ? { playerId: responsePayload.playerId as string } : undefined;
    processMagicCardSteps(sourceSocket, gameState, sourcePlayer, request.heroInstanceId, request.remainingEffects, chainPayload);
  }

  sendRoomUpdate();
};
export { processMagicCardSteps, handleMagicPromptResponse };

