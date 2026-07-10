// effects.ts — extracted from the original monolithic server.ts.
import type {
  ClientToServerEvents, ServerToClientEvents,
  CardInstance, CardTemplate, Effect, GameState, Player, MonsterInstance,
} from '../../shared/src/types.js';
import type { Socket } from 'socket.io';
import {
  emitAbilityPrompt, emitAbilityResolution, buildPromptId, getSocketByPlayerId,
  abilityPromptRequests, markHeroPlayedFromAbility, collectedDiscards, pidOf,
} from './state.js';
import type { AbilityPromptOption } from './state.js';
import { drawCards } from './cards.js';
import {
  moveCardBetweenZones, getOpponentPlayerIds, getHeroEffectiveClass, applyWinIfMet, isOpponent,
  promptForPlayerSelection, promptForCardSelection, getPlayerBySocketId, findHeroInPlayerParty,
  playerHasSlainEffectFlag, playerHasSlainEffectAction, playerHasTempFlag, WIN_CLASSES,
} from './util.js';
import { executeRollAndEmit } from './rolls.js';
import { processMagicCardSteps } from './magic.js';
import { triggerEndTurn } from './turns.js';
import { logGame } from './analytics.js';


// ── Slain-monster reactive passives ──────────────────────────────────────────
// Monsters a player has slain can grant ongoing abilities that react to later
// events (e.g. "each time you SACRIFICE a card..."). Call this at the point an
// `event` happens, passing the player it happened to; if that player has slain a
// monster whose slainEffect triggers on the event, the appropriate optional
// prompt is emitted to them. Resolution happens in handlePromptResponse
// (request.isSlainPassive).
const triggerSlainMonsterPassive = (
  gameState: GameState,
  ownerPlayerId: string,
  event: string,
) => {
  const player = gameState.players[ownerPlayerId];
  if (!player) return;
  const targetSocket = getSocketByPlayerId(gameState.gameId, ownerPlayerId);
  if (!targetSocket) return;
  const roomCode = targetSocket.data.roomCode as string;

  for (const monster of player.slainMonsters ?? []) {
    const slain = gameState.cardTemplates[monster.templateId]?.slainEffect;
    if (!slain || slain.triggerEvent !== event) continue;
    const monsterName = gameState.cardTemplates[monster.templateId]?.name ?? 'A slain monster';

    // m_001 Doombringer — ON_SACRIFICE: choose a card from discard → hand.
    if (slain.action === 'PROMPT_SELECT') {
      if (gameState.discardPile.length === 0) return;
      const options: AbilityPromptOption[] = gameState.discardPile.map((c) => ({
        id: c.instanceId,
        label: gameState.cardTemplates[c.templateId]?.name || c.templateId,
        payload: { cardInstanceId: c.instanceId },
      }));
      options.push({ id: 'skip', label: 'Skip (take nothing)' });
      emitAbilityPrompt(ownerPlayerId, {
        promptId: buildPromptId(),
        roomCode,
        heroInstanceId: '',
        sourcePlayerId: ownerPlayerId,
        promptType: 'selectCard',
        message: `${monsterName}: choose a card from the discard pile to add to your hand.`,
        options,
        effect: { action: 'SLAIN_PICK_FROM_DISCARD' },
        remainingEffects: [],
        isSlainPassive: true,
      });
      return;
    }

    // Optional "you may DRAW a card" reactive passives. The triggering event
    // determines the prompt wording; resolution is the shared SLAIN_DRAW_EXTRA.
    //   m_005 Rex Major          — ON_DRAW_MODIFIER (drew a Modifier)
    //   m_007 Arctic Aries       — ON_HERO_ABILITY_SUCCESS (succeeded a hero roll)
    //   m_011 Dracos             — ON_HERO_DESTROYED (a hero of yours was destroyed)
    //   m_006 Crowned Serpent    — ON_MODIFIER_PLAYED_ANY (any player played a Modifier)
    if (slain.action === 'DRAW_CARD') {
      if (gameState.mainDeck.length === 0) return;
      const reason: Record<string, string> = {
        ON_DRAW_MODIFIER: 'you drew a Modifier — draw a second card?',
        ON_HERO_ABILITY_SUCCESS: 'you succeeded a Hero roll — draw a card?',
        ON_HERO_DESTROYED: 'one of your Heroes was destroyed — draw a card?',
        ON_MODIFIER_PLAYED_ANY: 'a Modifier was played — draw a card?',
      };
      emitAbilityPrompt(ownerPlayerId, {
        promptId: buildPromptId(),
        roomCode,
        heroInstanceId: '',
        sourcePlayerId: ownerPlayerId,
        promptType: 'confirm',
        message: `${monsterName}: ${reason[event] ?? 'draw a card?'}`,
        options: [
          { id: 'yes', label: 'Draw a card' },
          { id: 'no', label: 'No thanks' },
        ],
        effect: { action: 'SLAIN_DRAW_EXTRA' },
        remainingEffects: [],
        isSlainPassive: true,
      });
      return;
    }
  }
};

// Draws `count` cards from the main deck into the player's hand and fires the
// ON_DRAW_MODIFIER slain-monster passive (m_005) for each Modifier drawn. Use
// this for every gameplay draw so the passive fires consistently. The passive's
// own bonus draw intentionally does NOT route through here, to avoid chaining.
const drawCardsForPlayer = (
  gameState: GameState,
  player: Player,
  count: number,
): CardInstance[] => {
  const drawn = drawCards(gameState.mainDeck, count);
  player.zones.hand.push(...drawn);
  if (drawn.length > 0) {
    logGame(gameState, 'cards_drawn', {
      count: drawn.length,
      templateIds: drawn.map(c => c.templateId),
    }, player.id);
  }
  for (const card of drawn) {
    // m_005 Rex Major — drew a Modifier: may draw a second card.
    if (card.cardType === 'modifier') {
      triggerSlainMonsterPassive(gameState, player.id, 'ON_DRAW_MODIFIER');
    }
    // m_008 Orthus / m_010 Malamammoth — drew a Magic/Item: may play it immediately.
    else if (card.cardType === 'magic') {
      offerPlayDrawnCard(gameState, player, card, 'magic');
    } else if (card.cardType === 'item') {
      offerPlayDrawnCard(gameState, player, card, 'item');
    }
  }
  return drawn;
};

// m_008 Orthus (magic) / m_010 Malamammoth (item): if `player` has slain the
// matching monster, offer to play the just-drawn card immediately.
//   magic → confirm prompt; on yes the card's effect resolves at once (not
//           challengeable — an "immediate" reactive play).
//   item  → choose one of your un-equipped heroes to equip it to (or skip).
const offerPlayDrawnCard = (
  gameState: GameState,
  player: Player,
  card: CardInstance,
  cardType: 'magic' | 'item',
): void => {
  const has = (player.slainMonsters ?? []).some((m) => {
    const s = gameState.cardTemplates[m.templateId]?.slainEffect;
    return s?.action === 'PLAY_DRAWN_CARD' && s.cardType === cardType;
  });
  if (!has) return;
  const socket = getSocketByPlayerId(gameState.gameId, player.id);
  if (!socket) return;
  const roomCode = socket.data.roomCode as string;
  const cardName = gameState.cardTemplates[card.templateId]?.name ?? card.templateId;

  if (cardType === 'magic') {
    emitAbilityPrompt(player.id, {
      promptId: buildPromptId(),
      roomCode,
      heroInstanceId: '',
      sourcePlayerId: player.id,
      promptType: 'confirm',
      message: `You drew ${cardName} — play it immediately?`,
      options: [
        { id: 'yes', label: `Play ${cardName}`, payload: { cardInstanceId: card.instanceId } },
        { id: 'no', label: 'Keep it in hand' },
      ],
      effect: { action: 'SLAIN_PLAY_MAGIC', cardInstanceId: card.instanceId },
      remainingEffects: [],
      isSlainPassive: true,
    });
    return;
  }

  // Cursed items must be played on opponents via the cursed-item flow, so they
  // cannot be "played immediately" by equipping to one of your own heroes — skip.
  if ((gameState.cardTemplates[card.templateId]?.subtype as string | undefined)?.toLowerCase() === 'cursed') return;

  const heroOptions: AbilityPromptOption[] = player.zones.party
    .filter((c) => c.cardType === 'hero' && !c.equippedItem)
    .map((c) => ({
      id: c.instanceId,
      label: gameState.cardTemplates[c.templateId]?.name || c.templateId,
      payload: { cardInstanceId: c.instanceId },
    }));
  if (heroOptions.length === 0) return; // nothing to equip it to
  heroOptions.push({ id: 'skip', label: 'Keep it in hand' });
  emitAbilityPrompt(player.id, {
    promptId: buildPromptId(),
    roomCode,
    heroInstanceId: '',
    sourcePlayerId: player.id,
    promptType: 'selectCard',
    message: `You drew ${cardName} — equip it to a hero immediately?`,
    options: heroOptions,
    effect: { action: 'SLAIN_PLAY_ITEM', itemInstanceId: card.instanceId },
    remainingEffects: [],
    isSlainPassive: true,
  });
};

// Destroys a hero on behalf of a hero ability, honoring per-card extras:
//   itemDestination 'hand' (h_050 Shurikitty) — the equipped item goes to the caster
//   berserkerBonusAP (h_054 Unbridled Fury) — +1 AP when the destroyed hero was a Berserker
// Protection (Terratuga / Mighty Blade / Decoy Doll) is handled by resolveHeroDestruction.
const performAbilityHeroDestroy = (
  gameState: GameState,
  caster: Player,
  ownerId: string,
  heroId: string,
  effect: Effect,
): string => {
  const owner = gameState.players[ownerId];
  const target = owner?.zones.party.find(c => c.instanceId === heroId);
  const targetClass = owner && target ? getHeroEffectiveClass(gameState, owner, target)?.toLowerCase() : undefined;
  const itemRecipient = effect.itemDestination === 'hand' ? caster : undefined;
  const result = resolveHeroDestruction(gameState, ownerId, heroId, itemRecipient);
  if (effect.berserkerBonusAP === true && targetClass === 'berserker' && result.startsWith('Destroyed')) {
    caster.actionPoints = (caster.actionPoints ?? 0) + 1;
    return `${result} It was a Berserker — +1 AP this turn.`;
  }
  return result;
};

const processHeroAbilityEffects = (
  sourceSocket: Socket<ClientToServerEvents, ServerToClientEvents>,
  gameState: GameState,
  player: Player,
  hero: CardInstance,
  template: CardTemplate,
  effects: Effect[],
  responsePayload?: { playerId?: string; cardInstanceId?: string; [key: string]: unknown },
  sendRoomUpdate: () => void = () => {}
): string | undefined => {
  const messages: string[] = [];
  let promptCreated = false;
  // Set when a targeted effect finds no legal target: the rest of the ability is
  // abandoned so unconditional follow-ups (e.g. FORCE_END_TURN) do not fire and the
  // ability is treated as a whiff (see activateHeroAbility's state-signature check).
  let aborted = false;

  for (let i = 0; i < effects.length; i++) {
    if (promptCreated || aborted) break;
    const effect = effects[i];
    if (!effect) continue;
    const remainingAfterThis = effects.slice(i + 1);
    let effectResult: string | undefined;

    switch (effect.action) {
      case 'DRAW': {
        if (responsePayload?.cardInstanceId) break; // skip re-execution when responding to a later prompt
        const amount = effect.amount ?? 1;
        const cards = drawCardsForPlayer(gameState, player, amount);
        effectResult = `Drew ${cards.length} card${cards.length === 1 ? '' : 's'} from the main deck.`;
        break;
      }
      case 'MOVE_CARD': {
        const targetZone = effect.destination === 'hand' ? player.zones.hand
          : effect.destination === 'party' ? player.zones.party
          : gameState.discardPile;
        // Card data stores targetRequirement under `activeSkill`; older code paths
        // also allowed it at the template top level, so fall back for safety.
        const targetReq = template.activeSkill?.targetRequirement ?? template.targetRequirement;

        if (responsePayload?.cardInstanceId) {
          let sourceZone: CardInstance[];
          if (responsePayload.playerId) {
            const srcPlayer = gameState.players[responsePayload.playerId];
            if (!srcPlayer) return 'Source player not found.';
            sourceZone = targetReq?.zone === 'party' ? srcPlayer.zones.party : srcPlayer.zones.hand;
          } else {
            sourceZone = gameState.discardPile;
          }
          const card = moveCardBetweenZones(sourceZone, targetZone, responsePayload.cardInstanceId);
          if (!card) return 'Could not move selected card.';
          return `${gameState.cardTemplates[card.templateId]?.name || 'Card'} moved to ${effect.destination}.`;
        }

        if (targetReq?.eligibility === 'opponent') {
          const allCandidates: Array<{ card: CardInstance; ownerId: string }> = [];
          for (const opId of getOpponentPlayerIds(gameState, pidOf(sourceSocket))) {
            const opp = gameState.players[opId];
            if (!opp) continue;
            // h_034 Calming Voice — party heroes of that player cannot be stolen.
            if (targetReq.zone === 'party' && playerHasTempFlag(opp, 'blockSteal')) continue;
            const zone: CardInstance[] = targetReq.zone === 'party' ? opp.zones.party : opp.zones.hand;
            for (const card of zone) {
              if (!targetReq.cardType || card.cardType === targetReq.cardType) {
                allCandidates.push({ card, ownerId: opId });
              }
            }
          }
          if (allCandidates.length === 0) { effectResult = 'No valid cards available.'; aborted = true; break; }
          const opponentOptions = allCandidates.map(({ card, ownerId }) => ({
            id: card.instanceId,
            label: `${gameState.cardTemplates[card.templateId]?.name || card.templateId} (${gameState.players[ownerId]?.username || 'opponent'})`,
            payload: { cardInstanceId: card.instanceId, playerId: ownerId },
          }));
          emitAbilityPrompt(pidOf(sourceSocket), {
            promptId: buildPromptId(),
            roomCode: sourceSocket.data.roomCode as string,
            heroInstanceId: hero.instanceId,
            sourcePlayerId: pidOf(sourceSocket),
            promptType: 'selectCard',
            message: 'Choose a card.',
            options: opponentOptions,
            effect,
            remainingEffects: remainingAfterThis,
          });
          promptCreated = true;
          break;
        }

        const cardTypeFilter = targetReq?.cardType;
        const candidates = gameState.discardPile.filter((card: CardInstance) =>
          !cardTypeFilter || card.cardType === cardTypeFilter
        );
        if (candidates.length === 0) { effectResult = `No valid ${cardTypeFilter || ''} cards in the discard pile.`; aborted = true; break; }
        promptForCardSelection(sourceSocket, gameState, hero.instanceId, effect, candidates, 'Choose a card to move.', remainingAfterThis);
        promptCreated = true;
        break;
      }
      case 'PROMPT_DISCARD': {
        if (responsePayload?.cardInstanceId) {
          const card = moveCardBetweenZones(player.zones.hand, gameState.discardPile, responsePayload.cardInstanceId);
          if (!card) return 'Could not discard selected card.';
          // h_025 Beary Wise: record the discard; when everyone prompted has
          // discarded, the caster picks one of the discarded cards to take.
          const collectKey = effect.collectKey as string | undefined;
          if (collectKey) {
            const rec = collectedDiscards.get(collectKey);
            if (rec) {
              rec.cardIds.push(card.instanceId);
              rec.remaining -= 1;
              if (rec.remaining <= 0) {
                collectedDiscards.delete(collectKey);
                const collected = rec.cardIds
                  .map(id => gameState.discardPile.find(c => c.instanceId === id))
                  .filter((c): c is CardInstance => !!c);
                if (collected.length > 0 && gameState.players[rec.casterId]) {
                  emitAbilityPrompt(rec.casterId, {
                    promptId: buildPromptId(),
                    roomCode: rec.roomCode,
                    heroInstanceId: rec.heroInstanceId,
                    sourcePlayerId: rec.casterId,
                    promptType: 'selectCard',
                    message: 'Choose one of the discarded cards to add to your hand.',
                    options: collected.map(c => ({
                      id: c.instanceId,
                      label: gameState.cardTemplates[c.templateId]?.name || c.templateId,
                      payload: { cardInstanceId: c.instanceId },
                    })),
                    effect: { action: 'TAKE_COLLECTED' },
                    remainingEffects: [],
                  });
                }
              }
            }
          }
          // Multi-card discards ("DISCARD 2 cards"): re-prompt the same player
          // for the remainder.
          const remainingCount = (effect.amount ?? 1) - 1;
          if (remainingCount > 0 && player.zones.hand.length > 0) {
            const moreOptions = player.zones.hand.map(c => ({
              id: c.instanceId,
              label: gameState.cardTemplates[c.templateId]?.name || c.templateId,
              payload: { cardInstanceId: c.instanceId },
            }));
            emitAbilityPrompt(player.id, {
              promptId: buildPromptId(),
              roomCode: sourceSocket.data.roomCode as string,
              heroInstanceId: hero.instanceId,
              sourcePlayerId: (effect.casterId as string | undefined) ?? pidOf(sourceSocket),
              promptType: 'discardCard',
              message: `Discard ${remainingCount} more card${remainingCount === 1 ? '' : 's'}.`,
              options: moreOptions,
              effect: { ...effect, amount: remainingCount },
              remainingEffects: [],
            });
          }
          return `Discarded ${gameState.cardTemplates[card.templateId]?.name || card.templateId}.`;
        }
        if (effect.target === 'self') {
          const selfOptions = player.zones.hand.map((card: CardInstance) => ({
            id: card.instanceId,
            label: gameState.cardTemplates[card.templateId]?.name || card.templateId,
            payload: { cardInstanceId: card.instanceId },
          }));
          if (selfOptions.length === 0) { effectResult = 'No cards to discard.'; aborted = true; break; }
          emitAbilityPrompt(pidOf(sourceSocket), {
            promptId: buildPromptId(),
            roomCode: sourceSocket.data.roomCode as string,
            heroInstanceId: hero.instanceId,
            sourcePlayerId: pidOf(sourceSocket),
            promptType: 'discardCard',
            message: `Discard ${effect.amount ?? 1} card${(effect.amount ?? 1) === 1 ? '' : 's'}.`,
            options: selfOptions,
            effect: { ...effect, casterId: pidOf(sourceSocket) },
            remainingEffects: remainingAfterThis,
          });
          promptCreated = true;
          break;
        }
        if (effect.target === 'all_opponents') {
          // h_025 Beary Wise: collect the discarded cards so the caster can take one.
          const collectKey = effect.collectThenTake === true ? buildPromptId() : undefined;
          const emittedEffect: Effect = collectKey
            ? { ...effect, casterId: pidOf(sourceSocket), collectKey }
            : { ...effect, casterId: pidOf(sourceSocket) };
          let discardPrompted = 0;
          for (const opponentId of getOpponentPlayerIds(gameState, pidOf(sourceSocket))) {
            const opponentSocket = getSocketByPlayerId(gameState.gameId, opponentId);
            if (!opponentSocket) continue;
            const opponent = gameState.players[opponentId];
            if (!opponent) continue;
            if (effect.condition && effect.condition.type === 'HAS_CARD_IN_ZONE') {
              const zoneName = effect.condition.zone as keyof typeof opponent.zones | undefined;
              const requiredClass = effect.condition.class ?? effect.condition.cardClass;
              const hasCard = !!zoneName && !!opponent.zones[zoneName]?.some((card: CardInstance) => {
                return requiredClass ? getHeroEffectiveClass(gameState, opponent, card)?.toLowerCase() === requiredClass?.toLowerCase() : true;
              });
              if (!hasCard) {
                opponentSocket.emit('abilityResolution', { heroInstanceId: hero.instanceId, message: 'Not affected by this ability.' });
                continue;
              }
            }
            const options = opponent.zones.hand.map((card: CardInstance) => ({
              id: card.instanceId,
              label: gameState.cardTemplates[card.templateId]?.name || card.templateId,
              payload: { cardInstanceId: card.instanceId },
            }));
            if (options.length === 0) {
              opponentSocket.emit('abilityResolution', { heroInstanceId: hero.instanceId, message: 'No cards to discard.' });
              continue;
            }
            const promptId = buildPromptId();
            abilityPromptRequests.set(promptId, {
              promptId,
              roomCode: sourceSocket.data.roomCode as string,
              heroInstanceId: hero.instanceId,
              sourcePlayerId: pidOf(sourceSocket),
              promptType: 'discardCard',
              message: `Discard ${effect.amount ?? 1} card${(effect.amount === 1) ? '' : 's'}.`,
              options,
              effect: emittedEffect,
              remainingEffects: [],
            });
            opponentSocket.emit('abilityPrompt', {
              promptId,
              heroInstanceId: hero.instanceId,
              promptType: 'discardCard',
              message: `Discard ${effect.amount ?? 1} card${(effect.amount === 1) ? '' : 's'}.`,
              options,
              requesterId: pidOf(sourceSocket),
            });
            discardPrompted++;
          }
          if (collectKey && discardPrompted > 0) {
            collectedDiscards.set(collectKey, {
              casterId: pidOf(sourceSocket),
              heroInstanceId: hero.instanceId,
              roomCode: sourceSocket.data.roomCode as string,
              remaining: discardPrompted,
              cardIds: [],
            });
          }
          return `Prompting opponents to discard ${effect.amount ?? 1} card${(effect.amount === 1) ? '' : 's'}.`;
        }
        if (effect.target === 'selected_player') {
          if (responsePayload?.playerId) {
            const targetPlayer = gameState.players[responsePayload.playerId];
            if (!targetPlayer) return 'Selected player not found.';
            const targetSocket = getSocketByPlayerId(gameState.gameId, responsePayload.playerId);
            if (!targetSocket) return 'Selected player not connected.';
            const options = targetPlayer.zones.hand.map((card: CardInstance) => ({
              id: card.instanceId,
              label: gameState.cardTemplates[card.templateId]?.name || card.templateId,
              payload: { cardInstanceId: card.instanceId },
            }));
            if (options.length === 0) {
              targetSocket.emit('abilityResolution', { heroInstanceId: hero.instanceId, message: 'No cards to discard.' });
              return `Player ${targetPlayer.username || 'Player'} has no cards to discard.`;
            }
            const promptId = buildPromptId();
            abilityPromptRequests.set(promptId, {
              promptId,
              roomCode: sourceSocket.data.roomCode as string,
              heroInstanceId: hero.instanceId,
              sourcePlayerId: pidOf(sourceSocket),
              promptType: 'discardCard',
              message: `Discard ${effect.amount ?? 1} card${(effect.amount === 1) ? '' : 's'}.`,
              options,
              effect: { ...effect, casterId: pidOf(sourceSocket) },
              remainingEffects: [],
            });
            targetSocket.emit('abilityPrompt', {
              promptId,
              heroInstanceId: hero.instanceId,
              promptType: 'discardCard',
              message: `Discard ${effect.amount ?? 1} card${(effect.amount === 1) ? '' : 's'}.`,
              options,
              requesterId: pidOf(sourceSocket),
            });
            return `Prompting ${targetPlayer.username || 'Player'} to discard ${effect.amount ?? 1} card${(effect.amount === 1) ? '' : 's'}.`;
          }
          const eligiblePlayers = Object.keys(gameState.players).filter((id) => isOpponent(id, pidOf(sourceSocket)));
          if (eligiblePlayers.length === 0) return 'No eligible players available.';
          promptForPlayerSelection(sourceSocket, gameState, hero.instanceId, effect, eligiblePlayers, 'Choose a player for this effect.', remainingAfterThis);
          promptCreated = true;
          break;
        }
        return 'Unsupported discard target.';
      }
      case 'PROMPT_SACRIFICE': {
        if (responsePayload?.cardInstanceId) {
          const sacrificeIndex = player.zones.party.findIndex((c: CardInstance) => c.instanceId === responsePayload.cardInstanceId);
          if (sacrificeIndex === -1) { effectResult = 'Selected card not found in party.'; break; }
          // i_011 Decoy Doll — absorbs the sacrifice; the hero survives.
          {
            const chosen = player.zones.party[sacrificeIndex];
            if (chosen?.cardType === 'hero' && tryDecoyDollRedirect(gameState, player, chosen.instanceId)) {
              effectResult = `A Decoy Doll protected ${gameState.cardTemplates[chosen.templateId]?.name || 'the hero'}.`;
              break;
            }
          }
          const [sacrificedCard] = player.zones.party.splice(sacrificeIndex, 1);
          if (!sacrificedCard) { effectResult = 'Failed to sacrifice card.'; break; }
          gameState.discardPile.push(sacrificedCard);
          triggerSlainMonsterPassive(gameState, player.id, 'ON_SACRIFICE');
          const sacrificedName = gameState.cardTemplates[sacrificedCard.templateId]?.name || sacrificedCard.templateId;
          let psMsg = `Sacrificed ${sacrificedName}.`;
          if (sacrificedCard.cardType === 'hero' && sacrificedCard.equippedItem) {
            const itemIndex = player.zones.party.findIndex((c) => c.instanceId === sacrificedCard.equippedItem);
            if (itemIndex !== -1) {
              const [psItem] = player.zones.party.splice(itemIndex, 1);
              if (psItem) {
                gameState.discardPile.push(psItem);
                psMsg += ` ${gameState.cardTemplates[psItem.templateId]?.name || psItem.templateId} was also discarded.`;
              }
            }
          }
          if (sacrificedCard.cardType === 'item') {
            const attachedHero = player.zones.party.find((c: CardInstance) => c.equippedItem === sacrificedCard.instanceId);
            if (attachedHero) delete attachedHero.equippedItem;
          }
          effectResult = psMsg;
          break;
        }
        if (effect.target === 'all_opponents' || effect.target === 'all_players') {
          // 'all_players' (h_017 Grim Pupper / h_058 Brawling Spirit) includes the caster.
          const sacrificeIds = effect.target === 'all_players'
            ? Object.keys(gameState.players)
            : getOpponentPlayerIds(gameState, pidOf(sourceSocket));
          const sacMessage = effect.cardType === 'hero'
            ? 'Sacrifice a Hero card from your party.'
            : 'Sacrifice a card from your party.';
          for (const targetId of sacrificeIds) {
            const targetSocket2 = getSocketByPlayerId(gameState.gameId, targetId);
            if (!targetSocket2) continue;
            const targetPlayer2 = gameState.players[targetId];
            if (!targetPlayer2) continue;
            // h_058 Brawling Spirit: only players with more than N party cards.
            if (effect.condition?.type === 'PARTY_SIZE_GT') {
              const partySize = targetPlayer2.zones.party.filter(c => c.cardType !== 'party_leader').length;
              if (partySize <= (effect.condition.amount ?? 3)) {
                targetSocket2.emit('abilityResolution', { heroInstanceId: hero.instanceId, message: 'Not affected by this ability.' });
                continue;
              }
            }
            const options = targetPlayer2.zones.party
              .filter((card: CardInstance) => card.cardType !== 'party_leader')
              .filter((card: CardInstance) => !effect.cardType || card.cardType === effect.cardType)
              .map((card: CardInstance) => ({
                id: card.instanceId,
                label: gameState.cardTemplates[card.templateId]?.name || card.templateId,
                payload: { cardInstanceId: card.instanceId },
              }));
            if (options.length === 0) {
              targetSocket2.emit('abilityResolution', { heroInstanceId: hero.instanceId, message: 'No cards to sacrifice.' });
              continue;
            }
            const promptId = buildPromptId();
            abilityPromptRequests.set(promptId, {
              promptId,
              roomCode: sourceSocket.data.roomCode as string,
              heroInstanceId: hero.instanceId,
              sourcePlayerId: pidOf(sourceSocket),
              promptType: 'discardCard',
              message: sacMessage,
              options,
              effect: { ...effect, casterId: pidOf(sourceSocket) },
              remainingEffects: [],
            });
            targetSocket2.emit('abilityPrompt', {
              promptId,
              heroInstanceId: hero.instanceId,
              promptType: 'discardCard',
              message: sacMessage,
              options,
              requesterId: pidOf(sourceSocket),
            });
          }
          return 'Prompting players to sacrifice a card.';
        }
        if (effect.target === 'selected_player') {
          // h_040 Hopper: caster picks a player; that player chooses the sacrifice.
          if (responsePayload?.playerId) {
            const sacTarget = gameState.players[responsePayload.playerId];
            const sacTargetSocket = getSocketByPlayerId(gameState.gameId, responsePayload.playerId);
            if (!sacTarget || !sacTargetSocket) return 'Selected player not found.';
            const options = sacTarget.zones.party
              .filter((card: CardInstance) => card.cardType !== 'party_leader')
              .filter((card: CardInstance) => !effect.cardType || card.cardType === effect.cardType)
              .map((card: CardInstance) => ({
                id: card.instanceId,
                label: gameState.cardTemplates[card.templateId]?.name || card.templateId,
                payload: { cardInstanceId: card.instanceId },
              }));
            if (options.length === 0) return `${sacTarget.username || 'Player'} has nothing to sacrifice.`;
            const promptId = buildPromptId();
            abilityPromptRequests.set(promptId, {
              promptId,
              roomCode: sourceSocket.data.roomCode as string,
              heroInstanceId: hero.instanceId,
              sourcePlayerId: pidOf(sourceSocket),
              promptType: 'discardCard',
              message: `Sacrifice a ${effect.cardType ?? ''} card from your party.`.replace('  ', ' '),
              options,
              effect: { ...effect, casterId: pidOf(sourceSocket) },
              remainingEffects: [],
            });
            sacTargetSocket.emit('abilityPrompt', {
              promptId,
              heroInstanceId: hero.instanceId,
              promptType: 'discardCard',
              message: `Sacrifice a ${effect.cardType ?? ''} card from your party.`.replace('  ', ' '),
              options,
              requesterId: pidOf(sourceSocket),
            });
            return `Prompting ${sacTarget.username || 'player'} to sacrifice.`;
          }
          const sacEligible = getOpponentPlayerIds(gameState, pidOf(sourceSocket))
            .filter(id => (gameState.players[id]?.zones.party ?? []).some(c =>
              c.cardType !== 'party_leader' && (!effect.cardType || c.cardType === effect.cardType)
            ));
          if (sacEligible.length === 0) { effectResult = 'No players have valid cards to sacrifice.'; aborted = true; break; }
          promptForPlayerSelection(sourceSocket, gameState, hero.instanceId, effect, sacEligible, 'Choose a player who must sacrifice.', remainingAfterThis);
          promptCreated = true;
          break;
        }
        return 'Unsupported sacrifice target.';
      }
      case 'SLAY': {
        if (responsePayload?.cardInstanceId) {
          const monsterIndex = gameState.activeMonsters.findIndex((m: MonsterInstance) => m.instanceId === responsePayload.cardInstanceId);
          if (monsterIndex === -1) { effectResult = 'Monster not found.'; break; }
          const [slain] = gameState.activeMonsters.splice(monsterIndex, 1);
          if (!slain) { effectResult = 'Failed to slay monster.'; break; }
          // A slay is a slay: the monster joins the player's slain pile (its slain
          // effect becomes active, and it counts toward the win condition).
          player.slainMonsters = player.slainMonsters ?? [];
          player.slainMonsters.push(slain);
          // p_001 Raging Manticore: draw N cards on slay.
          if (player.partyLeaderId) {
            const plTemplate = gameState.cardTemplates[player.partyLeaderId];
            if (plTemplate?.effect?.triggerEvent === 'ON_SLAY' && plTemplate.effect.action === 'DRAW') {
              drawCardsForPlayer(gameState, player, plTemplate.effect.amount ?? 1);
            }
          }
          if (gameState.activeMonsters.length < 3 && gameState.monsterDeck.length > 0) {
            gameState.activeMonsters.push(...(drawCards(gameState.monsterDeck, 1) as MonsterInstance[]));
          }
          applyWinIfMet(gameState, player, pidOf(sourceSocket));
          effectResult = `Slew ${gameState.cardTemplates[slain.templateId]?.name || 'monster'}!`;
          break;
        }
        if (effect.target === 'selected') {
          if (gameState.activeMonsters.length === 0) { effectResult = 'No monsters available to slay.'; aborted = true; break; }
          const slayOptions = gameState.activeMonsters.map((m: MonsterInstance) => ({
            id: m.instanceId,
            label: gameState.cardTemplates[m.templateId]?.name || m.templateId,
            payload: { cardInstanceId: m.instanceId },
          }));
          emitAbilityPrompt(pidOf(sourceSocket), {
            promptId: buildPromptId(),
            roomCode: sourceSocket.data.roomCode as string,
            heroInstanceId: hero.instanceId,
            sourcePlayerId: pidOf(sourceSocket),
            promptType: 'selectCard',
            message: 'Choose a monster to SLAY.',
            options: slayOptions,
            effect,
            remainingEffects: remainingAfterThis,
          });
          promptCreated = true;
          break;
        }
        effectResult = 'Unsupported SLAY target.';
        break;
      }
      case 'APPLY_ROOM_FLAG': {
        const roomFlags = gameState.roomFlags ?? {};
        if (effect.flag) roomFlags[effect.flag] = true;
        gameState.roomFlags = roomFlags;
        effectResult = `Applied: ${effect.flag || 'unknown'}.`;
        break;
      }
      case 'APPLY_PLAYER_MODIFIER': {
        const playerModifiers = player.temporaryModifiers ?? [];
        // Durations decrement at the end of the OWNER's turn, so:
        //   END_OF_TURN (1)  — expires when this turn ends.
        //   UNTIL_NEXT_TURN (2) — survives this turn's end, covering every
        //   opponent's turn until the owner acts again (h_032 / h_034).
        const rawDuration = effect.duration as number | string | undefined;
        const duration = rawDuration === 'UNTIL_NEXT_TURN' ? 2
          : typeof rawDuration === 'number' ? rawDuration : 1;
        playerModifiers.push({ modifierType: effect.modifierType ?? '', amount: effect.amount ?? 0, duration });
        player.temporaryModifiers = playerModifiers;
        effectResult = `Applied modifier: ${effect.modifierType}${effect.amount ? ` ${effect.amount}` : ''}.`;
        break;
      }
      case 'VIEW_HAND': {
        if (responsePayload?.playerId) {
          const targetPlayer = gameState.players[responsePayload.playerId];
          if (!targetPlayer) return 'Player not found.';
          const cardNames = targetPlayer.zones.hand.map((card: CardInstance) => gameState.cardTemplates[card.templateId]?.name || card.templateId);
          return `${targetPlayer.username || 'Player'} has: ${cardNames.join(', ') || 'no cards'}.`;
        }
        const eligiblePlayers = Object.keys(gameState.players).filter((id) => isOpponent(id, pidOf(sourceSocket)));
        promptForPlayerSelection(sourceSocket, gameState, hero.instanceId, effect, eligiblePlayers, 'Choose a player whose hand to view.', remainingAfterThis);
        promptCreated = true;
        break;
      }
      case 'STEAL_RANDOM_CARD': {
        if (effect.target === 'all_opponents') {
          const opponents = getOpponentPlayerIds(gameState, pidOf(sourceSocket)).filter((playerId) => {
            if (!effect.condition) return true;
            const opponent = gameState.players[playerId];
            if (!opponent) return false;
            if (effect.condition.type === 'HAS_CARD_IN_ZONE') {
              return opponent.zones[effect.condition.zone as keyof typeof opponent.zones]?.some((card: CardInstance) => {
                return getHeroEffectiveClass(gameState, opponent, card)?.toLowerCase() === effect.condition?.cardClass?.toLowerCase();
              });
            }
            return true;
          });
          const stolenCards: string[] = [];
          for (const opponentId of opponents) {
            const opponent = gameState.players[opponentId];
            if (!opponent || opponent.zones.hand.length === 0) continue;
            const cardIndex = Math.floor(Math.random() * opponent.zones.hand.length);
            const [card] = opponent.zones.hand.splice(cardIndex, 1);
            if (card) {
              player.zones.hand.push(card);
              stolenCards.push(gameState.cardTemplates[card.templateId]?.name || card.templateId);
            }
          }
          effectResult = `Stole ${stolenCards.length} card${stolenCards.length === 1 ? '' : 's'}${stolenCards.length > 0 ? `: ${stolenCards.join(', ')}` : ''}.`;
          break;
        }
        if (effect.target === 'target_owner' && responsePayload?.playerId) {
          const targetPlayer = gameState.players[responsePayload.playerId];
          if (!targetPlayer || targetPlayer.zones.hand.length === 0) { effectResult = 'No cards to steal.'; break; }
          const cardIndex = Math.floor(Math.random() * targetPlayer.zones.hand.length);
          const [card] = targetPlayer.zones.hand.splice(cardIndex, 1);
          if (!card) { effectResult = 'Failed to steal a card.'; break; }
          player.zones.hand.push(card);
          effectResult = `Stole ${gameState.cardTemplates[card.templateId]?.name || card.templateId} from ${targetPlayer.username || 'player'}.`;
          break;
        }
        effectResult = 'Unsupported steal action.';
        break;
      }
      case 'PLAY_FROM_HAND': {
        const playType = effect.cardType as string;
        // Cursed items are played on opponents via their own flow — never "from hand" here.
        const candidates = player.zones.hand.filter((card: CardInstance) =>
          card.cardType === playType &&
          !(card.cardType === 'item' && (gameState.cardTemplates[card.templateId]?.subtype as string | undefined)?.toLowerCase() === 'cursed')
        );
        if (candidates.length === 0) { effectResult = `No ${effect.cardType} cards available to play.`; aborted = true; break; }
        if (responsePayload?.cardInstanceId) {
          const index = player.zones.hand.findIndex((card: CardInstance) => card.instanceId === responsePayload.cardInstanceId);
          if (index === -1) { effectResult = 'Selected card not found in hand.'; break; }
          const selected = player.zones.hand[index]!;
          // h_063 Hook: a selected item must be equipped to one of your heroes.
          if (selected.cardType === 'item') {
            const selectedName = gameState.cardTemplates[selected.templateId]?.name || selected.templateId;
            const freeHeroes = player.zones.party.filter(c => c.cardType === 'hero' && !c.equippedItem);
            if (freeHeroes.length === 0) { effectResult = `No hero free to equip ${selectedName} — kept in hand.`; break; }
            const equipOptions = freeHeroes.map(c => ({
              id: c.instanceId,
              label: gameState.cardTemplates[c.templateId]?.name || c.templateId,
              payload: { cardInstanceId: c.instanceId },
            }));
            emitAbilityPrompt(pidOf(sourceSocket), {
              promptId: buildPromptId(),
              roomCode: sourceSocket.data.roomCode as string,
              heroInstanceId: hero.instanceId,
              sourcePlayerId: pidOf(sourceSocket),
              promptType: 'selectCard',
              message: `Equip ${selectedName} to which hero?`,
              options: equipOptions,
              effect: { action: 'HERO_EQUIP_FROM_HAND', itemInstanceId: selected.instanceId },
              remainingEffects: [],
            });
            promptCreated = true;
            break;
          }
          const [card] = player.zones.hand.splice(index, 1);
          if (!card) { effectResult = 'Failed to play card from hand.'; break; }
          player.zones.party.push(card);
          applyWinIfMet(gameState, player, pidOf(sourceSocket));
          const roomCode = sourceSocket.data.roomCode as string;
          markHeroPlayedFromAbility(roomCode, card.instanceId);
          sourceSocket.emit('heroPlayedFromAbility', card.instanceId);
          effectResult = `Played ${gameState.cardTemplates[card.templateId]?.name || card.templateId} from your hand.`;
          break;
        }
        promptForCardSelection(sourceSocket, gameState, hero.instanceId, effect, candidates, `Choose a ${playType} card from your hand to play.`, remainingAfterThis);
        promptCreated = true;
        break;
      }
      case 'SACRIFICE': {
        if (!responsePayload?.cardInstanceId) { effectResult = 'No card selected for sacrifice.'; break; }
        const sacrificeIndex = player.zones.party.findIndex((c: CardInstance) => c.instanceId === responsePayload.cardInstanceId);
        if (sacrificeIndex === -1) { effectResult = 'Selected card not found in party.'; break; }
        // i_011 Decoy Doll — absorbs the sacrifice; the hero survives.
        {
          const chosen = player.zones.party[sacrificeIndex];
          if (chosen?.cardType === 'hero' && tryDecoyDollRedirect(gameState, player, chosen.instanceId)) {
            effectResult = `A Decoy Doll protected ${gameState.cardTemplates[chosen.templateId]?.name || 'the hero'}.`;
            break;
          }
        }
        const [sacrificedCard] = player.zones.party.splice(sacrificeIndex, 1);
        if (!sacrificedCard) { effectResult = 'Failed to sacrifice card.'; break; }
        gameState.discardPile.push(sacrificedCard);
        triggerSlainMonsterPassive(gameState, player.id, 'ON_SACRIFICE');
        const sacrificedName = gameState.cardTemplates[sacrificedCard.templateId]?.name || sacrificedCard.templateId;
        let sacrificeMsg = `Sacrificed ${sacrificedName}.`;
        if (sacrificedCard.cardType === 'hero' && sacrificedCard.equippedItem) {
          const itemIndex = player.zones.party.findIndex((c: CardInstance) => c.instanceId === sacrificedCard.equippedItem);
          if (itemIndex !== -1) {
            const [sacrificedItem] = player.zones.party.splice(itemIndex, 1);
            if (sacrificedItem) {
              gameState.discardPile.push(sacrificedItem);
              sacrificeMsg += ` ${gameState.cardTemplates[sacrificedItem.templateId]?.name || sacrificedItem.templateId} was also discarded.`;
            }
          }
        }
        if (sacrificedCard.cardType === 'item') {
          const attachedHero = player.zones.party.find((c: CardInstance) => c.equippedItem === sacrificedCard.instanceId);
          if (attachedHero) delete attachedHero.equippedItem;
        }
        effectResult = sacrificeMsg;
        break;
      }
      case 'FORCE_END_TURN': {
        gameState.forceEndTurn = pidOf(sourceSocket);
        effectResult = 'Ending turn.';
        break;
      }
      case 'NOOP': {
        // h_045 Napping Nibbles: "Do nothing."
        effectResult = 'Nothing happens. Zzz…';
        break;
      }
      case 'DESTROY_HERO': {
        if (responsePayload?.cardInstanceId) {
          const heroId = responsePayload.cardInstanceId;
          let ownerId = responsePayload.playerId;
          if (!ownerId) {
            for (const [opId, opp] of Object.entries(gameState.players)) {
              if (opp.zones.party.some(c => c.instanceId === heroId)) { ownerId = opId; break; }
            }
          }
          if (!ownerId) { effectResult = 'Hero not found.'; break; }
          const owner = gameState.players[ownerId];
          // m_012 Corrupted Sabretooth — the destroyer may STEAL the hero instead
          // (not offered when the owner's heroes can't be stolen).
          if (
            owner &&
            playerHasSlainEffectAction(gameState, player, 'STEAL_INSTEAD_OF_DESTROY') &&
            !playerHasTempFlag(owner, 'blockSteal')
          ) {
            const target = owner.zones.party.find(c => c.instanceId === heroId);
            const targetName = target ? gameState.cardTemplates[target.templateId]?.name ?? 'that Hero' : 'that Hero';
            emitAbilityPrompt(pidOf(sourceSocket), {
              promptId: buildPromptId(),
              roomCode: sourceSocket.data.roomCode as string,
              heroInstanceId: hero.instanceId,
              sourcePlayerId: pidOf(sourceSocket),
              promptType: 'confirm',
              message: `Corrupted Sabretooth: STEAL ${targetName} instead of destroying it?`,
              options: [
                { id: 'steal', label: `Steal ${targetName}`, payload: { choice: 'steal', cardInstanceId: heroId, playerId: ownerId } },
                { id: 'destroy', label: 'Destroy it', payload: { choice: 'destroy', cardInstanceId: heroId, playerId: ownerId } },
              ],
              effect: { ...effect, action: 'SABRETOOTH_RESOLVE' },
              remainingEffects: remainingAfterThis,
            });
            promptCreated = true;
            break;
          }
          effectResult = performAbilityHeroDestroy(gameState, player, ownerId, heroId, effect);
          break;
        }
        const destroyOptions: AbilityPromptOption[] = [];
        for (const [opId, opp] of Object.entries(gameState.players)) {
          if (opId === pidOf(sourceSocket)) continue;
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
        if (destroyOptions.length === 0) { effectResult = 'No opponent heroes to destroy.'; aborted = true; break; }
        emitAbilityPrompt(pidOf(sourceSocket), {
          promptId: buildPromptId(),
          roomCode: sourceSocket.data.roomCode as string,
          heroInstanceId: hero.instanceId,
          sourcePlayerId: pidOf(sourceSocket),
          promptType: 'selectCard',
          message: 'Choose a Hero to DESTROY.',
          options: destroyOptions,
          effect,
          remainingEffects: remainingAfterThis,
        });
        promptCreated = true;
        break;
      }
      case 'SABRETOOTH_RESOLVE': {
        const heroId = responsePayload?.cardInstanceId;
        const ownerId = responsePayload?.playerId;
        if (!heroId || !ownerId) { effectResult = 'Hero not found.'; break; }
        if (responsePayload?.choice === 'steal') {
          const owner = gameState.players[ownerId];
          const stolen = owner ? moveCardBetweenZones(owner.zones.party, player.zones.party, heroId) : undefined;
          if (stolen) {
            if (stolen.equippedItem && owner) moveCardBetweenZones(owner.zones.party, player.zones.party, stolen.equippedItem);
            applyWinIfMet(gameState, player, pidOf(sourceSocket));
            effectResult = `Stole ${gameState.cardTemplates[stolen.templateId]?.name || 'hero'}.`;
          } else effectResult = 'Hero not found.';
        } else {
          effectResult = performAbilityHeroDestroy(gameState, player, ownerId, heroId, effect);
        }
        break;
      }
      case 'STEAL_HERO': {
        if (responsePayload?.cardInstanceId && responsePayload?.playerId) {
          const opponent = gameState.players[responsePayload.playerId];
          if (!opponent) { effectResult = 'Opponent not found.'; break; }
          const stolen = moveCardBetweenZones(opponent.zones.party, player.zones.party, responsePayload.cardInstanceId);
          if (!stolen) { effectResult = 'Could not steal hero.'; break; }
          if (stolen.equippedItem) moveCardBetweenZones(opponent.zones.party, player.zones.party, stolen.equippedItem);
          const stolenName = gameState.cardTemplates[stolen.templateId]?.name || 'hero';
          let msg = `Stole ${stolenName} from ${opponent.username || 'opponent'}.`;
          applyWinIfMet(gameState, player, pidOf(sourceSocket));
          // h_041 Tipsy Tootie: this hero joins the robbed player's party.
          if (effect.giveSelfAfter === true) {
            const moved = moveCardBetweenZones(player.zones.party, opponent.zones.party, hero.instanceId);
            if (moved?.equippedItem) moveCardBetweenZones(player.zones.party, opponent.zones.party, moved.equippedItem);
            if (moved) msg += ` ${gameState.cardTemplates[moved.templateId]?.name || 'This hero'} joined their party.`;
            applyWinIfMet(gameState, opponent, responsePayload.playerId);
          }
          // h_022 Perfect Vessel: sacrifice this hero after stealing.
          if (effect.sacrificeSelfAfter === true) {
            if (tryDecoyDollRedirect(gameState, player, hero.instanceId)) {
              msg += ' A Decoy Doll absorbed the sacrifice.';
            } else {
              const selfIdx = player.zones.party.findIndex(c => c.instanceId === hero.instanceId);
              if (selfIdx !== -1) {
                const [self] = player.zones.party.splice(selfIdx, 1);
                if (self) {
                  gameState.discardPile.push(self);
                  if (self.equippedItem) {
                    const itemIdx = player.zones.party.findIndex(c => c.instanceId === self.equippedItem);
                    if (itemIdx !== -1) {
                      const [item] = player.zones.party.splice(itemIdx, 1);
                      if (item) gameState.discardPile.push(item);
                    }
                  }
                  triggerSlainMonsterPassive(gameState, player.id, 'ON_SACRIFICE');
                  msg += ` Sacrificed ${gameState.cardTemplates[self.templateId]?.name || 'this hero'}.`;
                }
              }
            }
          }
          // h_035 Wiggles: roll the stolen hero's effect immediately (no AP cost).
          if (effect.rollAfter === true) {
            msg += ` Rolling ${stolenName}'s effect…`;
            executeRollAndEmit(sourceSocket, gameState, player, stolen, 0, sendRoomUpdate);
          }
          effectResult = msg;
          break;
        }
        const stealOptions: AbilityPromptOption[] = [];
        for (const [opId, opp] of Object.entries(gameState.players)) {
          if (opId === pidOf(sourceSocket)) continue;
          // h_034 Calming Voice — that player's heroes cannot be stolen.
          if (playerHasTempFlag(opp, 'blockSteal')) continue;
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
        if (stealOptions.length === 0) { effectResult = 'No opponent heroes to steal.'; aborted = true; break; }
        emitAbilityPrompt(pidOf(sourceSocket), {
          promptId: buildPromptId(),
          roomCode: sourceSocket.data.roomCode as string,
          heroInstanceId: hero.instanceId,
          sourcePlayerId: pidOf(sourceSocket),
          promptType: 'selectCard',
          message: 'Choose a Hero to STEAL.',
          options: stealOptions,
          effect,
          remainingEffects: remainingAfterThis,
        });
        promptCreated = true;
        break;
      }
      case 'PULL_RANDOM': {
        if (responsePayload?.playerId && !responsePayload?.cardInstanceId) {
          const target = gameState.players[responsePayload.playerId];
          if (!target) { effectResult = 'Player not found.'; break; }
          const count = (effect.count as number | undefined) ?? 1;
          const pulled: CardInstance[] = [];
          for (let p = 0; p < count && target.zones.hand.length > 0; p++) {
            const idx = Math.floor(Math.random() * target.zones.hand.length);
            const [c] = target.zones.hand.splice(idx, 1);
            if (c) { player.zones.hand.push(c); pulled.push(c); }
          }
          if (pulled.length === 0) { effectResult = 'No cards to pull.'; break; }
          const pulledNames = pulled.map(c => gameState.cardTemplates[c.templateId]?.name || c.templateId);
          let msg = `Pulled ${pulledNames.join(', ')}.`;
          // h_024 Bear Claw / h_026 Fury Knuckle: a matching pull grants a second pull.
          const bonusType = effect.bonusPullType as string | undefined;
          if (bonusType && pulled[0]?.cardType === bonusType && target.zones.hand.length > 0) {
            const idx2 = Math.floor(Math.random() * target.zones.hand.length);
            const [c2] = target.zones.hand.splice(idx2, 1);
            if (c2) {
              player.zones.hand.push(c2);
              msg += ` It was a ${bonusType} card — also pulled ${gameState.cardTemplates[c2.templateId]?.name || c2.templateId}.`;
            }
          }
          // h_044 Lucky Bucky / h_051 Sly Pickings / h_037 Buttons: may play a matching pull.
          const mayPlayType = effect.mayPlayType as string | undefined;
          const match = mayPlayType ? pulled.find(c => c.cardType === mayPlayType) : undefined;
          if (match) {
            const matchName = gameState.cardTemplates[match.templateId]?.name || match.templateId;
            emitAbilityPrompt(pidOf(sourceSocket), {
              promptId: buildPromptId(),
              roomCode: sourceSocket.data.roomCode as string,
              heroInstanceId: hero.instanceId,
              sourcePlayerId: pidOf(sourceSocket),
              promptType: 'confirm',
              message: `You pulled ${matchName} — play it immediately?`,
              options: [
                { id: 'yes', label: `Play ${matchName}`, payload: { confirm: true, cardInstanceId: match.instanceId } },
                { id: 'no', label: 'Keep it in hand', payload: { confirm: false } },
              ],
              effect: { action: 'HERO_PLAY_TAKEN_CARD' },
              remainingEffects: [],
            });
            promptCreated = true;
            effectResult = msg;
            break;
          }
          // h_048 Slippery Paws: discard one of the pulled cards.
          if (effect.discardOneAfter === true) {
            const discardOpts = pulled.map(c => ({
              id: c.instanceId,
              label: gameState.cardTemplates[c.templateId]?.name || c.templateId,
              payload: { cardInstanceId: c.instanceId },
            }));
            emitAbilityPrompt(pidOf(sourceSocket), {
              promptId: buildPromptId(),
              roomCode: sourceSocket.data.roomCode as string,
              heroInstanceId: hero.instanceId,
              sourcePlayerId: pidOf(sourceSocket),
              promptType: 'discardCard',
              message: 'Discard one of the pulled cards.',
              options: discardOpts,
              effect: { action: 'PROMPT_DISCARD', target: 'self', amount: 1, casterId: pidOf(sourceSocket) },
              remainingEffects: [],
            });
            promptCreated = true;
            effectResult = msg;
            break;
          }
          // h_053 Plundering Puma: the robbed player may draw a card.
          if (effect.targetMayDraw === true) {
            emitAbilityPrompt(target.id, {
              promptId: buildPromptId(),
              roomCode: sourceSocket.data.roomCode as string,
              heroInstanceId: hero.instanceId,
              sourcePlayerId: pidOf(sourceSocket),
              promptType: 'confirm',
              message: 'Plundering Puma pulled 2 of your cards — draw a card?',
              options: [
                { id: 'yes', label: 'Draw a card', payload: { confirm: true } },
                { id: 'no', label: 'No thanks', payload: { confirm: false } },
              ],
              effect: { action: 'HERO_TARGET_DRAW_CONFIRM' },
              remainingEffects: [],
            });
          }
          effectResult = msg;
          break;
        }
        const pullEligible = getOpponentPlayerIds(gameState, pidOf(sourceSocket))
          .filter(id => (gameState.players[id]?.zones.hand.length ?? 0) > 0);
        if (pullEligible.length === 0) { effectResult = 'No opponents have cards to pull.'; aborted = true; break; }
        promptForPlayerSelection(sourceSocket, gameState, hero.instanceId, effect, pullEligible, 'Choose a player to pull from.', remainingAfterThis);
        promptCreated = true;
        break;
      }
      case 'HERO_TARGET_DRAW_CONFIRM': {
        if (responsePayload?.confirm === true) {
          drawCardsForPlayer(gameState, player, 1);
          effectResult = 'Drew a card.';
        } else {
          effectResult = 'Declined the draw.';
        }
        break;
      }
      case 'TAKE_FROM_HAND': {
        if (responsePayload?.cardInstanceId && responsePayload?.playerId) {
          const target = gameState.players[responsePayload.playerId];
          if (!target) { effectResult = 'Player not found.'; break; }
          const taken = moveCardBetweenZones(target.zones.hand, player.zones.hand, responsePayload.cardInstanceId);
          if (!taken) { effectResult = 'Card not found.'; break; }
          const takenName = gameState.cardTemplates[taken.templateId]?.name || taken.templateId;
          // h_019 Hollow Husk: may play the taken Magic card immediately.
          if (effect.mayPlay === true && taken.cardType === 'magic') {
            emitAbilityPrompt(pidOf(sourceSocket), {
              promptId: buildPromptId(),
              roomCode: sourceSocket.data.roomCode as string,
              heroInstanceId: hero.instanceId,
              sourcePlayerId: pidOf(sourceSocket),
              promptType: 'confirm',
              message: `You took ${takenName} — play it immediately?`,
              options: [
                { id: 'yes', label: `Play ${takenName}`, payload: { confirm: true, cardInstanceId: taken.instanceId } },
                { id: 'no', label: 'Keep it in hand', payload: { confirm: false } },
              ],
              effect: { action: 'HERO_PLAY_TAKEN_CARD' },
              remainingEffects: [],
            });
            promptCreated = true;
            effectResult = `Took ${takenName}.`;
            break;
          }
          effectResult = `Took ${takenName} from ${target.username || 'player'}.`;
          break;
        }
        // h_059 Gruesome Gladiator: choose a card from EACH opponent's hand.
        if (effect.target === 'all_opponents') {
          let prompted = 0;
          for (const opId of getOpponentPlayerIds(gameState, pidOf(sourceSocket))) {
            const opp = gameState.players[opId];
            if (!opp || opp.zones.hand.length === 0) continue;
            const handOptions = opp.zones.hand.map(c => ({
              id: c.instanceId,
              label: gameState.cardTemplates[c.templateId]?.name || c.templateId,
              payload: { cardInstanceId: c.instanceId, playerId: opId },
            }));
            emitAbilityPrompt(pidOf(sourceSocket), {
              promptId: buildPromptId(),
              roomCode: sourceSocket.data.roomCode as string,
              heroInstanceId: hero.instanceId,
              sourcePlayerId: pidOf(sourceSocket),
              promptType: 'selectCard',
              message: `${opp.username || 'Opponent'}'s hand — choose a card to take.`,
              options: handOptions,
              effect: { action: 'TAKE_FROM_HAND' },
              remainingEffects: [],
            });
            prompted++;
          }
          effectResult = prompted > 0
            ? `Looking at ${prompted} hand${prompted === 1 ? '' : 's'}…`
            : 'No opponents have cards.';
          if (prompted > 0) promptCreated = true;
          break;
        }
        // Selected-player flow (h_052 Silent Shadow / h_019 Hollow Husk).
        if (responsePayload?.playerId) {
          const target = gameState.players[responsePayload.playerId];
          if (!target) { effectResult = 'Player not found.'; break; }
          const handNames = target.zones.hand
            .map(c => gameState.cardTemplates[c.templateId]?.name || c.templateId)
            .join(', ') || 'no cards';
          const filter = effect.cardTypeFilter as string | undefined;
          const selectable = filter ? target.zones.hand.filter(c => c.cardType === filter) : target.zones.hand;
          if (selectable.length === 0) {
            effectResult = `${target.username || 'Player'}'s hand: ${handNames}. ${filter ? `No ${filter} cards to take.` : 'No cards to take.'}`;
            break;
          }
          const takeOptions = selectable.map(c => ({
            id: c.instanceId,
            label: gameState.cardTemplates[c.templateId]?.name || c.templateId,
            payload: { cardInstanceId: c.instanceId, playerId: target.id },
          }));
          emitAbilityPrompt(pidOf(sourceSocket), {
            promptId: buildPromptId(),
            roomCode: sourceSocket.data.roomCode as string,
            heroInstanceId: hero.instanceId,
            sourcePlayerId: pidOf(sourceSocket),
            promptType: 'selectCard',
            message: `${target.username || 'Player'}'s hand: ${handNames}. Choose a card to take.`,
            options: takeOptions,
            effect,
            remainingEffects: remainingAfterThis,
          });
          promptCreated = true;
          break;
        }
        const lookEligible = getOpponentPlayerIds(gameState, pidOf(sourceSocket))
          .filter(id => (gameState.players[id]?.zones.hand.length ?? 0) > 0);
        if (lookEligible.length === 0) { effectResult = 'No opponents have cards.'; aborted = true; break; }
        promptForPlayerSelection(sourceSocket, gameState, hero.instanceId, effect, lookEligible, 'Choose a player whose hand to look at.', remainingAfterThis);
        promptCreated = true;
        break;
      }
      case 'HERO_PLAY_TAKEN_CARD': {
        if (responsePayload?.confirm === false || !responsePayload?.cardInstanceId) {
          effectResult = 'Kept in hand.';
          break;
        }
        const handIdx = player.zones.hand.findIndex(c => c.instanceId === responsePayload.cardInstanceId);
        if (handIdx === -1) { effectResult = 'Card not found in hand.'; break; }
        const playCard = player.zones.hand[handIdx]!;
        const playName = gameState.cardTemplates[playCard.templateId]?.name || playCard.templateId;
        const drawBonus = (effect.drawBonus as number | undefined) ?? 0;
        if (playCard.cardType === 'hero') {
          player.zones.hand.splice(handIdx, 1);
          player.zones.party.push(playCard);
          applyWinIfMet(gameState, player, player.id);
          const playRoomCode = sourceSocket.data.roomCode as string;
          markHeroPlayedFromAbility(playRoomCode, playCard.instanceId);
          sourceSocket.emit('heroPlayedFromAbility', playCard.instanceId);
          effectResult = `Played ${playName}.`;
        } else if (playCard.cardType === 'magic') {
          player.zones.hand.splice(handIdx, 1);
          gameState.discardPile.push(playCard);
          const magicTemplate = gameState.cardTemplates[playCard.templateId];
          if (magicTemplate?.effect) {
            const steps: Effect[] = magicTemplate.effect.steps ?? [magicTemplate.effect as unknown as Effect];
            processMagicCardSteps(sourceSocket, gameState, player, playCard.instanceId, steps, undefined, true);
          }
          effectResult = `Played ${playName}.`;
        } else if (playCard.cardType === 'item') {
          if ((gameState.cardTemplates[playCard.templateId]?.subtype as string | undefined)?.toLowerCase() === 'cursed') {
            effectResult = `${playName} is cursed — kept in hand (cursed items are played on opponents).`;
            break;
          }
          const freeHeroes = player.zones.party.filter(c => c.cardType === 'hero' && !c.equippedItem);
          if (freeHeroes.length === 0) { effectResult = `No hero free to equip ${playName} — kept in hand.`; break; }
          const equipOptions = freeHeroes.map(c => ({
            id: c.instanceId,
            label: gameState.cardTemplates[c.templateId]?.name || c.templateId,
            payload: { cardInstanceId: c.instanceId },
          }));
          emitAbilityPrompt(pidOf(sourceSocket), {
            promptId: buildPromptId(),
            roomCode: sourceSocket.data.roomCode as string,
            heroInstanceId: hero.instanceId,
            sourcePlayerId: pidOf(sourceSocket),
            promptType: 'selectCard',
            message: `Equip ${playName} to which hero?`,
            options: equipOptions,
            effect: { action: 'HERO_EQUIP_FROM_HAND', itemInstanceId: playCard.instanceId, drawBonus },
            remainingEffects: [],
          });
          promptCreated = true;
          break;
        } else {
          effectResult = `${playName} cannot be played immediately — kept in hand.`;
          break;
        }
        if (drawBonus > 0) {
          drawCardsForPlayer(gameState, player, drawBonus);
          effectResult += ` Drew ${drawBonus} more card${drawBonus === 1 ? '' : 's'}.`;
        }
        break;
      }
      case 'HERO_EQUIP_FROM_HAND': {
        const equipItemId = effect.itemInstanceId as string | undefined;
        const equipTargetId = responsePayload?.cardInstanceId;
        if (!equipItemId || !equipTargetId) { effectResult = 'Kept in hand.'; break; }
        const equipHero = player.zones.party.find(c => c.instanceId === equipTargetId && c.cardType === 'hero' && !c.equippedItem);
        const equipItemIdx = player.zones.hand.findIndex(c => c.instanceId === equipItemId);
        if (!equipHero || equipItemIdx === -1) { effectResult = 'Could not equip the item.'; break; }
        const [equipItem] = player.zones.hand.splice(equipItemIdx, 1);
        if (!equipItem) { effectResult = 'Could not equip the item.'; break; }
        player.zones.party.push(equipItem);
        equipHero.equippedItem = equipItem.instanceId;
        effectResult = `Equipped ${gameState.cardTemplates[equipItem.templateId]?.name || 'item'} to ${gameState.cardTemplates[equipHero.templateId]?.name || 'hero'}.`;
        const equipDrawBonus = (effect.drawBonus as number | undefined) ?? 0;
        if (equipDrawBonus > 0) {
          drawCardsForPlayer(gameState, player, equipDrawBonus);
          effectResult += ` Drew ${equipDrawBonus} more card${equipDrawBonus === 1 ? '' : 's'}.`;
        }
        break;
      }
      case 'HERO_CONFIRM_CHAIN': {
        if (responsePayload?.confirm !== true) { effectResult = 'Skipped.'; break; }
        const followUp = effect.followUp as string | undefined;
        if (!followUp) { effectResult = 'Nothing to do.'; break; }
        effectResult = processHeroAbilityEffects(sourceSocket, gameState, player, hero, template, [{ action: followUp }], undefined, sendRoomUpdate);
        break;
      }
      case 'DRAW_AND_CHECK': {
        if (responsePayload?.cardInstanceId) break; // guard against chained re-execution
        const checkAmount = effect.amount ?? 1;
        const drawn = drawCardsForPlayer(gameState, player, checkAmount);
        const matchType = effect.matchType as string | undefined;
        let matched = drawn.filter(c => c.cardType === matchType);
        // Cursed items can't be played on your own heroes — don't offer them.
        if (matchType === 'item') {
          matched = matched.filter(c => (gameState.cardTemplates[c.templateId]?.subtype as string | undefined)?.toLowerCase() !== 'cursed');
        }
        const drewMsg = `Drew ${drawn.length} card${drawn.length === 1 ? '' : 's'}.`;
        if (matched.length === 0) { effectResult = drewMsg; break; }
        const matchedNames = matched.map(c => gameState.cardTemplates[c.templateId]?.name || c.templateId).join(', ');
        const thenAction = effect.then as string | undefined;
        if (thenAction === 'DESTROY_HERO') {
          // h_023 Pan Chucks: may reveal the drawn Challenge card to destroy a hero.
          emitAbilityPrompt(pidOf(sourceSocket), {
            promptId: buildPromptId(),
            roomCode: sourceSocket.data.roomCode as string,
            heroInstanceId: hero.instanceId,
            sourcePlayerId: pidOf(sourceSocket),
            promptType: 'confirm',
            message: `You drew ${matchedNames}! Reveal it to DESTROY a Hero card?`,
            options: [
              { id: 'yes', label: 'Reveal and DESTROY a Hero', payload: { confirm: true } },
              { id: 'no', label: 'Keep it hidden', payload: { confirm: false } },
            ],
            effect: { action: 'HERO_CONFIRM_CHAIN', followUp: 'DESTROY_HERO' },
            remainingEffects: [],
          });
          promptCreated = true;
          effectResult = drewMsg;
          break;
        }
        // PLAY_MATCHED / PLAY_MATCHED_DRAW (h_047 Mellow Dee, h_060 Quick Draw, h_036 Snowball)
        const checkDrawBonus = thenAction === 'PLAY_MATCHED_DRAW' ? 1 : 0;
        const playOptions: AbilityPromptOption[] = matched.map(c => ({
          id: c.instanceId,
          label: gameState.cardTemplates[c.templateId]?.name || c.templateId,
          payload: { cardInstanceId: c.instanceId },
        }));
        playOptions.push({ id: 'skip', label: 'Keep in hand', payload: { confirm: false } });
        emitAbilityPrompt(pidOf(sourceSocket), {
          promptId: buildPromptId(),
          roomCode: sourceSocket.data.roomCode as string,
          heroInstanceId: hero.instanceId,
          sourcePlayerId: pidOf(sourceSocket),
          promptType: 'selectCard',
          message: `You drew ${matchedNames} — play one immediately?`,
          options: playOptions,
          effect: { action: 'HERO_PLAY_TAKEN_CARD', drawBonus: checkDrawBonus },
          remainingEffects: [],
        });
        promptCreated = true;
        effectResult = drewMsg;
        break;
      }
      case 'DRAW_TO_HAND_SIZE': {
        const targetSize = effect.amount ?? 7;
        const need = targetSize - player.zones.hand.length;
        if (need <= 0) { effectResult = `Already holding ${player.zones.hand.length} cards.`; break; }
        const drawnUp = drawCardsForPlayer(gameState, player, need);
        effectResult = `Drew ${drawnUp.length} card${drawnUp.length === 1 ? '' : 's'}.`;
        break;
      }
      case 'PEEK_TOP_DECK': {
        const top = gameState.mainDeck.slice(0, effect.amount ?? 3);
        if (top.length === 0) { effectResult = 'The deck is empty.'; aborted = true; break; }
        const peekOptions = top.map(c => ({
          id: c.instanceId,
          label: `${gameState.cardTemplates[c.templateId]?.name || c.templateId} (${c.cardType})`,
          payload: { cardInstanceId: c.instanceId },
        }));
        emitAbilityPrompt(pidOf(sourceSocket), {
          promptId: buildPromptId(),
          roomCode: sourceSocket.data.roomCode as string,
          heroInstanceId: hero.instanceId,
          sourcePlayerId: pidOf(sourceSocket),
          promptType: 'selectCard',
          message: 'Top of the deck — choose a card to add to your hand.',
          options: peekOptions,
          effect: { action: 'PEEK_TOP_TAKE' },
          remainingEffects: remainingAfterThis,
        });
        promptCreated = true;
        break;
      }
      case 'PEEK_TOP_TAKE': {
        if (!responsePayload?.cardInstanceId) { effectResult = 'No card taken.'; break; }
        const peekIdx = gameState.mainDeck.findIndex(c => c.instanceId === responsePayload.cardInstanceId);
        if (peekIdx === -1 || peekIdx > 2) { effectResult = 'Card is no longer on top of the deck.'; break; }
        const [taken] = gameState.mainDeck.splice(peekIdx, 1);
        if (!taken) { effectResult = 'Card not found.'; break; }
        player.zones.hand.push(taken);
        effectResult = `Took ${gameState.cardTemplates[taken.templateId]?.name || taken.templateId}.`;
        const restOnTop = gameState.mainDeck.slice(0, 2);
        if (restOnTop.length === 2) {
          const orderOptions = restOnTop.map(c => ({
            id: c.instanceId,
            label: gameState.cardTemplates[c.templateId]?.name || c.templateId,
            payload: { cardInstanceId: c.instanceId },
          }));
          emitAbilityPrompt(pidOf(sourceSocket), {
            promptId: buildPromptId(),
            roomCode: sourceSocket.data.roomCode as string,
            heroInstanceId: hero.instanceId,
            sourcePlayerId: pidOf(sourceSocket),
            promptType: 'selectCard',
            message: 'Choose which card goes ON TOP of the deck.',
            options: orderOptions,
            effect: { action: 'PEEK_TOP_ORDER' },
            remainingEffects: [],
          });
          promptCreated = true;
        }
        break;
      }
      case 'PEEK_TOP_ORDER': {
        const topChoice = responsePayload?.cardInstanceId;
        if (topChoice && gameState.mainDeck[1]?.instanceId === topChoice) {
          const first = gameState.mainDeck[0];
          const second = gameState.mainDeck[1];
          if (first && second) {
            gameState.mainDeck[0] = second;
            gameState.mainDeck[1] = first;
          }
        }
        effectResult = 'Returned the other cards to the top of the deck.';
        break;
      }
      case 'RETURN_CURSED_ITEM': {
        if (responsePayload?.cardInstanceId) {
          const cursedIdx = player.zones.party.findIndex(c => c.instanceId === responsePayload.cardInstanceId);
          if (cursedIdx === -1) { effectResult = 'Item not found.'; break; }
          const [cursedItem] = player.zones.party.splice(cursedIdx, 1);
          if (!cursedItem) { effectResult = 'Item not found.'; break; }
          const cursedHero = player.zones.party.find(c => c.equippedItem === cursedItem.instanceId);
          if (cursedHero) delete cursedHero.equippedItem;
          player.zones.hand.push(cursedItem);
          effectResult = `Returned ${gameState.cardTemplates[cursedItem.templateId]?.name || 'the cursed item'} to your hand.`;
          break;
        }
        const cursedItems = player.zones.party.filter(c =>
          c.cardType === 'item' &&
          (gameState.cardTemplates[c.templateId]?.subtype as string | undefined)?.toLowerCase() === 'cursed'
        );
        if (cursedItems.length === 0) { effectResult = 'No Cursed Items equipped to your heroes.'; aborted = true; break; }
        promptForCardSelection(sourceSocket, gameState, hero.instanceId, effect, cursedItems, 'Choose a Cursed Item to return to your hand.', remainingAfterThis);
        promptCreated = true;
        break;
      }
      case 'RETURN_CLASS_TO_HAND': {
        const chosenClass = responsePayload?.classId as string | undefined;
        if (chosenClass) {
          let returned = 0;
          for (const p of Object.values(gameState.players)) {
            const matching = p.zones.party.filter(c =>
              c.cardType === 'hero' &&
              getHeroEffectiveClass(gameState, p, c)?.toLowerCase() === chosenClass.toLowerCase()
            );
            for (const h of matching) {
              if (h.equippedItem) {
                moveCardBetweenZones(p.zones.party, p.zones.hand, h.equippedItem);
                delete h.equippedItem;
              }
              moveCardBetweenZones(p.zones.party, p.zones.hand, h.instanceId);
              returned++;
            }
          }
          effectResult = `Returned ${returned} ${chosenClass} Hero card${returned === 1 ? '' : 's'} to their owners' hands.`;
          break;
        }
        const classOptions: AbilityPromptOption[] = WIN_CLASSES.map(cls => ({
          id: cls,
          label: cls.charAt(0).toUpperCase() + cls.slice(1),
          payload: { classId: cls },
        }));
        emitAbilityPrompt(pidOf(sourceSocket), {
          promptId: buildPromptId(),
          roomCode: sourceSocket.data.roomCode as string,
          heroInstanceId: hero.instanceId,
          sourcePlayerId: pidOf(sourceSocket),
          promptType: 'selectCard',
          message: 'Choose a Class — every Hero card of that Class returns to its owner\'s hand.',
          options: classOptions,
          effect,
          remainingEffects: remainingAfterThis,
        });
        promptCreated = true;
        break;
      }
      case 'TRADE_HANDS': {
        if (responsePayload?.playerId) {
          const tradeTarget = gameState.players[responsePayload.playerId];
          if (!tradeTarget) { effectResult = 'Player not found.'; break; }
          const mine = player.zones.hand;
          player.zones.hand = tradeTarget.zones.hand;
          tradeTarget.zones.hand = mine;
          effectResult = `Traded hands with ${tradeTarget.username || 'player'}.`;
          break;
        }
        const tradeEligible = getOpponentPlayerIds(gameState, pidOf(sourceSocket));
        if (tradeEligible.length === 0) { effectResult = 'No players to trade with.'; aborted = true; break; }
        promptForPlayerSelection(sourceSocket, gameState, hero.instanceId, effect, tradeEligible, 'Choose a player to trade hands with.', remainingAfterThis);
        promptCreated = true;
        break;
      }
      case 'GIVE_CARD': {
        if (responsePayload?.cardInstanceId) {
          // The responder gives their chosen card to the caster.
          const giveCasterId = (effect.casterId as string | undefined) ?? pidOf(sourceSocket);
          const giveCaster = gameState.players[giveCasterId];
          if (!giveCaster) { effectResult = 'Caster not found.'; break; }
          const given = moveCardBetweenZones(player.zones.hand, giveCaster.zones.hand, responsePayload.cardInstanceId);
          effectResult = given
            ? `Gave ${gameState.cardTemplates[given.templateId]?.name || given.templateId} to ${giveCaster.username || 'them'}.`
            : 'Card not found.';
          break;
        }
        let givePrompted = 0;
        for (const opId of getOpponentPlayerIds(gameState, pidOf(sourceSocket))) {
          const opp = gameState.players[opId];
          if (!opp || opp.zones.hand.length === 0) continue;
          const giveOptions = opp.zones.hand.map(c => ({
            id: c.instanceId,
            label: gameState.cardTemplates[c.templateId]?.name || c.templateId,
            payload: { cardInstanceId: c.instanceId },
          }));
          emitAbilityPrompt(opId, {
            promptId: buildPromptId(),
            roomCode: sourceSocket.data.roomCode as string,
            heroInstanceId: hero.instanceId,
            sourcePlayerId: pidOf(sourceSocket),
            promptType: 'selectCard',
            message: `Choose a card to give to ${player.username || 'the caster'}.`,
            options: giveOptions,
            effect: { action: 'GIVE_CARD', casterId: pidOf(sourceSocket) },
            remainingEffects: [],
          });
          givePrompted++;
        }
        effectResult = givePrompted > 0
          ? `Waiting for ${givePrompted} player${givePrompted === 1 ? '' : 's'} to give you a card…`
          : 'No opponents have cards to give.';
        if (givePrompted > 0) promptCreated = true;
        break;
      }
      case 'GIVE_OR_RECOVER': {
        if (responsePayload?.playerId) {
          const askTarget = gameState.players[responsePayload.playerId];
          if (!askTarget) { effectResult = 'Player not found.'; break; }
          const askOptions: AbilityPromptOption[] = askTarget.zones.hand.map(c => ({
            id: c.instanceId,
            label: gameState.cardTemplates[c.templateId]?.name || c.templateId,
            payload: { cardInstanceId: c.instanceId },
          }));
          askOptions.push({ id: 'decline', label: 'Decline (they take 2 cards from the discard pile)', payload: { decline: true } });
          emitAbilityPrompt(askTarget.id, {
            promptId: buildPromptId(),
            roomCode: sourceSocket.data.roomCode as string,
            heroInstanceId: hero.instanceId,
            sourcePlayerId: pidOf(sourceSocket),
            promptType: 'selectCard',
            message: `${player.username || 'A player'} asks for a card — give one, or decline?`,
            options: askOptions,
            effect: { action: 'GIVE_OR_RECOVER_RESPOND', casterId: pidOf(sourceSocket), recoverAmount: effect.recoverAmount ?? 2 },
            remainingEffects: [],
          });
          promptCreated = true;
          effectResult = `Waiting for ${askTarget.username || 'player'}…`;
          break;
        }
        const askEligible = getOpponentPlayerIds(gameState, pidOf(sourceSocket));
        if (askEligible.length === 0) { effectResult = 'No players to choose.'; aborted = true; break; }
        promptForPlayerSelection(sourceSocket, gameState, hero.instanceId, effect, askEligible, 'Choose a player.', remainingAfterThis);
        promptCreated = true;
        break;
      }
      case 'GIVE_OR_RECOVER_RESPOND': {
        const respCasterId = effect.casterId as string | undefined;
        const respCaster = respCasterId ? gameState.players[respCasterId] : undefined;
        if (!respCaster || !respCasterId) { effectResult = 'Caster not found.'; break; }
        if (responsePayload?.cardInstanceId) {
          const givenCard = moveCardBetweenZones(player.zones.hand, respCaster.zones.hand, responsePayload.cardInstanceId);
          effectResult = givenCard
            ? `Gave ${gameState.cardTemplates[givenCard.templateId]?.name || givenCard.templateId}.`
            : 'Card not found.';
          break;
        }
        // Declined — the caster may take up to N cards from the discard pile.
        const recoverAmount = (effect.recoverAmount as number | undefined) ?? 2;
        if (gameState.discardPile.length === 0) { effectResult = 'Declined — but the discard pile is empty.'; break; }
        const recoverOptions = gameState.discardPile.map(c => ({
          id: c.instanceId,
          label: gameState.cardTemplates[c.templateId]?.name || c.templateId,
          payload: { cardInstanceId: c.instanceId },
        }));
        emitAbilityPrompt(respCasterId, {
          promptId: buildPromptId(),
          roomCode: sourceSocket.data.roomCode as string,
          heroInstanceId: hero.instanceId,
          sourcePlayerId: respCasterId,
          promptType: 'multiSelectCard',
          message: `They declined — choose up to ${recoverAmount} cards from the discard pile.`,
          options: recoverOptions,
          minSelections: 0,
          maxSelections: Math.min(recoverAmount, gameState.discardPile.length),
          effect: { action: 'HERO_TAKE_DISCARD_MULTI' },
          remainingEffects: [],
        });
        promptCreated = true;
        effectResult = 'Declined to give a card.';
        break;
      }
      case 'RECOVER_AND_PLAY': {
        if (responsePayload?.cardInstanceId) {
          const recIdx = gameState.discardPile.findIndex(c => c.instanceId === responsePayload.cardInstanceId);
          if (recIdx === -1) { effectResult = 'Card not found in the discard pile.'; break; }
          const recCard = gameState.discardPile[recIdx]!;
          const recName = gameState.cardTemplates[recCard.templateId]?.name || recCard.templateId;
          gameState.discardPile.splice(recIdx, 1);
          if (recCard.cardType === 'hero') {
            player.zones.party.push(recCard);
            applyWinIfMet(gameState, player, player.id);
            const recRoomCode = sourceSocket.data.roomCode as string;
            markHeroPlayedFromAbility(recRoomCode, recCard.instanceId);
            sourceSocket.emit('heroPlayedFromAbility', recCard.instanceId);
            effectResult = `Recovered and played ${recName}.`;
            break;
          }
          // Item: equip immediately if a hero is free, else keep in hand.
          player.zones.hand.push(recCard);
          const recFreeHeroes = player.zones.party.filter(c => c.cardType === 'hero' && !c.equippedItem);
          if (recCard.cardType !== 'item' || recFreeHeroes.length === 0) {
            effectResult = `Recovered ${recName} (kept in hand).`;
            break;
          }
          const recEquipOptions = recFreeHeroes.map(c => ({
            id: c.instanceId,
            label: gameState.cardTemplates[c.templateId]?.name || c.templateId,
            payload: { cardInstanceId: c.instanceId },
          }));
          emitAbilityPrompt(pidOf(sourceSocket), {
            promptId: buildPromptId(),
            roomCode: sourceSocket.data.roomCode as string,
            heroInstanceId: hero.instanceId,
            sourcePlayerId: pidOf(sourceSocket),
            promptType: 'selectCard',
            message: `Equip ${recName} to which hero?`,
            options: recEquipOptions,
            effect: { action: 'HERO_EQUIP_FROM_HAND', itemInstanceId: recCard.instanceId },
            remainingEffects: [],
          });
          promptCreated = true;
          effectResult = `Recovered ${recName}.`;
          break;
        }
        const recTypes = (effect.cardTypes as string[] | undefined) ?? ['hero'];
        const recCandidates = gameState.discardPile.filter(c =>
          recTypes.includes(c.cardType) &&
          !(c.cardType === 'item' && (gameState.cardTemplates[c.templateId]?.subtype as string | undefined)?.toLowerCase() === 'cursed')
        );
        if (recCandidates.length === 0) { effectResult = 'No matching cards in the discard pile.'; aborted = true; break; }
        promptForCardSelection(sourceSocket, gameState, hero.instanceId, effect, recCandidates, 'Choose a card from the discard pile to play.', remainingAfterThis);
        promptCreated = true;
        break;
      }
      case 'MULTI_SELECT_CHAIN': {
        const zoneName = effect.selectionZone as string | undefined;
        const pool = zoneName === 'party'
          ? player.zones.party.filter(c => c.cardType !== 'party_leader')
          : player.zones.hand;
        if (pool.length === 0) { effectResult = 'No cards to select.'; aborted = true; break; }
        const chainMax = Math.min((effect.max as number | undefined) ?? pool.length, pool.length);
        const chainVerb = effect.removalMode === 'sacrifice' ? 'SACRIFICE' : 'DISCARD';
        const chainOptions = pool.map(c => ({
          id: c.instanceId,
          label: gameState.cardTemplates[c.templateId]?.name || c.templateId,
          payload: { cardInstanceId: c.instanceId },
        }));
        emitAbilityPrompt(pidOf(sourceSocket), {
          promptId: buildPromptId(),
          roomCode: sourceSocket.data.roomCode as string,
          heroInstanceId: hero.instanceId,
          sourcePlayerId: pidOf(sourceSocket),
          promptType: 'multiSelectCard',
          message: `Select up to ${chainMax} card${chainMax === 1 ? '' : 's'} to ${chainVerb} — each lets you DESTROY a Hero card.`,
          options: chainOptions,
          minSelections: (effect.min as number | undefined) ?? 0,
          maxSelections: chainMax,
          effect: { action: 'HERO_MULTI_CHAIN_RESOLVE', removalMode: effect.removalMode, followUpAction: effect.followUpAction },
          remainingEffects: [],
        });
        promptCreated = true;
        break;
      }
      case 'TAKE_COLLECTED': {
        if (responsePayload?.cardInstanceId) {
          const colIdx = gameState.discardPile.findIndex(c => c.instanceId === responsePayload.cardInstanceId);
          if (colIdx !== -1) {
            const [colCard] = gameState.discardPile.splice(colIdx, 1);
            if (colCard) {
              player.zones.hand.push(colCard);
              effectResult = `Took ${gameState.cardTemplates[colCard.templateId]?.name || colCard.templateId} from the discarded cards.`;
              break;
            }
          }
          effectResult = 'Card not found.';
          break;
        }
        effectResult = 'No card taken.';
        break;
      }
      default:
        effectResult = `Unsupported ability action: ${effect.action}`;
        break;
    }
    if (effectResult !== undefined) {
      messages.push(effectResult);
    }
  }

  if (messages.length > 0) {
    return messages.join(' ');
  }
  return undefined;
};

// Resolves the destruction of a single hero card, honoring two slain-monster
// passives: m_014 Terratuga (the owner's heroes cannot be destroyed) and m_011
// Dracos (the owner may DRAW when one of their heroes is destroyed). Returns a
// short result string. Does NOT handle the m_012 Corrupted Sabretooth
// steal-instead choice — that is offered to the destroyer before this is called.
// Decoy Doll (i_011): an equipped item that absorbs a sacrifice/destroy aimed at
// its hero. If the given hero has a Decoy Doll equipped, discard the doll, unequip
// it, and report that the hero survives. Returns true when the removal was redirected.
const isDecoyDoll = (gameState: GameState, item: CardInstance): boolean =>
  gameState.cardTemplates[item.templateId]?.passiveModifiers?.some(p => p.stat === 'redirectSacrificeDestroy') === true;

const tryDecoyDollRedirect = (
  gameState: GameState,
  owner: Player | undefined,
  heroInstanceId: string | undefined,
): boolean => {
  if (!owner || !heroInstanceId) return false;
  const hero = owner.zones.party.find(c => c.instanceId === heroInstanceId && c.cardType === 'hero');
  if (!hero?.equippedItem) return false;
  const itemIdx = owner.zones.party.findIndex(c => c.instanceId === hero.equippedItem);
  if (itemIdx === -1) return false;
  const item = owner.zones.party[itemIdx];
  if (!item || !isDecoyDoll(gameState, item)) return false;
  owner.zones.party.splice(itemIdx, 1);
  gameState.discardPile.push(item);
  delete hero.equippedItem;
  return true;
};

const resolveHeroDestruction = (
  gameState: GameState,
  ownerPlayerId: string,
  heroInstanceId: string,
  itemRecipient?: Player,
): string => {
  const owner = gameState.players[ownerPlayerId];
  if (!owner) return 'Hero owner not found.';
  // m_014 Terratuga / h_032 Mighty Blade — the owner's heroes cannot be destroyed.
  if (
    playerHasSlainEffectFlag(gameState, owner, 'blockHeroDestruction') ||
    playerHasTempFlag(owner, 'blockHeroDestruction')
  ) {
    const blocked = owner.zones.party.find(c => c.instanceId === heroInstanceId);
    const name = blocked ? gameState.cardTemplates[blocked.templateId]?.name : undefined;
    return `${name ?? 'That hero'} cannot be destroyed (protected).`;
  }
  // i_011 Decoy Doll — the doll is discarded instead and the hero survives.
  if (tryDecoyDollRedirect(gameState, owner, heroInstanceId)) {
    return 'A Decoy Doll absorbed the destruction — the hero survives.';
  }
  const heroIdx = owner.zones.party.findIndex(c => c.instanceId === heroInstanceId);
  if (heroIdx === -1) return 'Hero not found.';
  const [hero] = owner.zones.party.splice(heroIdx, 1);
  if (!hero) return 'Hero not found.';
  gameState.discardPile.push(hero);
  if (hero.equippedItem) {
    const itemIdx = owner.zones.party.findIndex(c => c.instanceId === hero.equippedItem);
    if (itemIdx !== -1) {
      const [item] = owner.zones.party.splice(itemIdx, 1);
      // h_050 Shurikitty: the equipped item goes to the destroyer's hand instead.
      if (item) {
        if (itemRecipient) itemRecipient.zones.hand.push(item);
        else gameState.discardPile.push(item);
      }
    }
  }
  // m_011 Dracos — the owner may DRAW a card when their hero is destroyed.
  triggerSlainMonsterPassive(gameState, ownerPlayerId, 'ON_HERO_DESTROYED');
  return `Destroyed ${gameState.cardTemplates[hero.templateId]?.name || 'hero'}.`;
};

// A cheap signature of every piece of mutable state an active skill could touch.
// Used to detect a "whiff": an ability activated with no legal target changes
// nothing, so it should NOT be consumed and the player may try again later.
const stateSignature = (gameState: GameState): string => {
  const players = Object.values(gameState.players).map(p =>
    `${p.id}|h${p.zones.hand.length}|p${p.zones.party.map(c => `${c.instanceId}:${c.equippedItem ?? ''}`).join(',')}` +
    `|s${(p.slainMonsters ?? []).length}|ap${p.actionPoints ?? 0}|m${JSON.stringify(p.temporaryModifiers ?? [])}`
  ).join(';');
  return `${players}#d${gameState.discardPile.length}#mon${gameState.activeMonsters.length}` +
    `#deck${gameState.mainDeck.length}#flags${JSON.stringify(gameState.roomFlags ?? {})}#end${gameState.forceEndTurn ?? ''}`;
};

const activateHeroAbility = (
  sourceSocket: Socket<ClientToServerEvents, ServerToClientEvents>,
  gameState: GameState,
  heroInstanceId: string,
  sendRoomUpdate: () => void
) => {
  const player = getPlayerBySocketId(gameState, pidOf(sourceSocket));
  if (!player) {
    sourceSocket.emit('actionFailed', 'Player not found.');
    return;
  }

  const hero = findHeroInPlayerParty(player, heroInstanceId);
  if (!hero) {
    sourceSocket.emit('actionFailed', 'Hero not found in your party.');
    return;
  }

  const template = gameState.cardTemplates[hero.templateId];
  if (!template?.activeSkill || !Array.isArray(template.activeSkill.effects)) {
    sourceSocket.emit('actionFailed', 'This hero has no ability to activate.');
    return;
  }

  logGame(gameState, 'hero_ability_activated', { heroTemplateId: hero.templateId }, pidOf(sourceSocket));

  // Handle costs (SACRIFICE / DISCARD) before processing effects
  const costs = template.activeSkill.costs ?? [];

  const discardCost = costs.find(c => c.type === 'DISCARD');
  if (discardCost) {
    const cardTypeFilter = discardCost.cardType;
    const discardOptions = player.zones.hand
      .filter((card) => !cardTypeFilter || cardTypeFilter === 'any' || card.cardType === cardTypeFilter)
      .map((card) => ({
        id: card.instanceId,
        label: gameState.cardTemplates[card.templateId]?.name || card.templateId,
        payload: { cardInstanceId: card.instanceId },
      }));
    if (discardOptions.length === 0) {
      sourceSocket.emit('actionFailed', 'No valid cards in hand to discard.');
      return;
    }
    const label = cardTypeFilter && cardTypeFilter !== 'any' ? `a ${cardTypeFilter} card` : 'a card';
    const promptId = buildPromptId();
    abilityPromptRequests.set(promptId, {
      promptId,
      roomCode: sourceSocket.data.roomCode as string,
      heroInstanceId,
      sourcePlayerId: pidOf(sourceSocket),
      promptType: 'discardCard',
      message: `Discard ${label} from your hand.`,
      options: discardOptions,
      effect: { action: 'PROMPT_DISCARD', target: 'self' },
      remainingEffects: template.activeSkill.effects,
    });
    sourceSocket.emit('abilityPrompt', {
      promptId,
      heroInstanceId,
      promptType: 'discardCard',
      message: `Discard ${label} from your hand.`,
      options: discardOptions,
      requesterId: pidOf(sourceSocket),
    });
    return;
  }

  const sacrificeCost = costs.find(c => c.type === 'SACRIFICE');
  if (sacrificeCost) {
    const sacCardType = sacrificeCost.cardType;
    const sacrificeOptions = player.zones.party
      .filter((card) => card.cardType !== 'party_leader')
      .filter((card) => !sacCardType || sacCardType === 'any' || card.cardType === sacCardType)
      .map((card) => ({
        id: card.instanceId,
        label: gameState.cardTemplates[card.templateId]?.name || card.templateId,
        payload: { cardInstanceId: card.instanceId },
      }));
    const sacLabel = sacCardType && sacCardType !== 'any' ? `a ${sacCardType} card` : 'a card';
    if (sacrificeOptions.length === 0) {
      sourceSocket.emit('actionFailed', `No ${sacCardType && sacCardType !== 'any' ? `${sacCardType} ` : ''}cards available to sacrifice.`);
      return;
    }
    const promptId = buildPromptId();
    abilityPromptRequests.set(promptId, {
      promptId,
      roomCode: sourceSocket.data.roomCode as string,
      heroInstanceId,
      sourcePlayerId: pidOf(sourceSocket),
      promptType: 'discardCard',
      message: `Choose ${sacLabel} to sacrifice.`,
      options: sacrificeOptions,
      effect: { action: 'SACRIFICE', ...sacrificeCost } as Effect,
      remainingEffects: template.activeSkill.effects,
    });
    sourceSocket.emit('abilityPrompt', {
      promptId,
      heroInstanceId,
      promptType: 'discardCard',
      message: `Choose ${sacLabel} to sacrifice.`,
      options: sacrificeOptions,
      requesterId: pidOf(sourceSocket),
    });
    return;
  }

  // NOOP / VIEW_HAND intentionally change no state but still "use" the ability.
  const alwaysConsumes = template.activeSkill.effects.some(e => e.action === 'NOOP' || e.action === 'VIEW_HAND');
  const before = stateSignature(gameState);

  const result = processHeroAbilityEffects(sourceSocket, gameState, player, hero, template, template.activeSkill.effects, undefined, sendRoomUpdate);

  // Check if a prompt was just emitted (waiting for user input)
  // If so, don't call emitAbilityResolution yet; let handlePromptResponse handle it
  const pendingPrompts = Array.from(abilityPromptRequests.values()).filter(
    (req) => req.heroInstanceId === heroInstanceId && req.sourcePlayerId === pidOf(sourceSocket)
  );

  if (pendingPrompts.length === 0) {
    // Whiff: no prompt awaited and nothing changed → no legal target. Do not consume
    // the ability (it stays usable this turn) and tell the player why.
    if (!alwaysConsumes && stateSignature(gameState) === before) {
      sourceSocket.emit('actionFailed', result ?? 'No legal target for this ability.');
      sendRoomUpdate();
      return;
    }
    hero.effectUsedThisTurn = true;
    if (result) emitAbilityResolution(sourceSocket, heroInstanceId, result);
    const forcedTurnPlayerId = gameState.forceEndTurn;
    if (forcedTurnPlayerId) {
      triggerEndTurn(forcedTurnPlayerId, gameState, sourceSocket.data.roomCode as string, sendRoomUpdate);
    } else {
      sendRoomUpdate();
    }
  }
  // If there are pending prompts, handlePromptResponse will handle marking as used and sending resolution
};
export {
  triggerSlainMonsterPassive, drawCardsForPlayer, offerPlayDrawnCard, performAbilityHeroDestroy,
  processHeroAbilityEffects, isDecoyDoll, tryDecoyDollRedirect, resolveHeroDestruction, activateHeroAbility,
};

