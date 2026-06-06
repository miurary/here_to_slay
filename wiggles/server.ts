import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

import type { ClientToServerEvents, ServerToClientEvents, CardInstance, GameState, Player, MonsterInstance } from '../shared/types.js'

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const cardsDir = join(__dirname, 'cards');

type CardTemplate = { id: string; type: string; name: string; [key: string]: any };

const shuffle = <T>(items: T[]): T[] => {
  return items.slice().sort(() => Math.random() - 0.5);
};

const loadCardDefinitions = (filename: string): CardTemplate[] => {
  const raw = readFileSync(join(cardsDir, filename), 'utf8');
  const json = JSON.parse(raw) as Record<string, CardTemplate>;
  return Object.values(json);
};

const createCardInstances = (templates: CardTemplate[]): CardInstance[] => {
  return templates.map((template) => ({
    instanceId: `${template.id}-${randomUUID()}`,
    templateId: template.id,
    cardType: mapTemplateType(template.type),
    effectUsedThisTurn: false,
  }));
};

const mapTemplateType = (type: string): CardInstance['cardType'] => {
  const normalized = type.toLowerCase();
  if (normalized === 'partyleader' || normalized === 'party_leader') return 'party_leader';
  if (normalized === 'hero') return 'hero';
  if (normalized === 'item' || normalized === 'cursed_item') return 'item';
  if (normalized === 'magic') return 'magic';
  if (normalized === 'modifier') return 'modifier';
  if (normalized === 'challenge') return 'challenge';
  if (normalized === 'monster') return 'monster';
  return 'magic';
};

const drawCards = (deck: CardInstance[], count: number): CardInstance[] => {
  return deck.splice(0, count);
};

const initializeDecks = () => {
  const monsterTemplates = loadCardDefinitions('monster.json');
  const partyLeaderTemplates = loadCardDefinitions('party_leader.json');
  const mainTemplates = [
    ...loadCardDefinitions('hero.json'),
    ...loadCardDefinitions('item.json'),
    ...loadCardDefinitions('magic.json'),
    ...loadCardDefinitions('modifier.json'),
    ...loadCardDefinitions('challenge.json'),
    ...loadCardDefinitions('cursed_item.json'),
  ];

  return {
    monsterDeck: shuffle(createCardInstances(monsterTemplates)),
    partyLeaderDeck: shuffle(createCardInstances(partyLeaderTemplates)),
    mainDeck: shuffle(createCardInstances(mainTemplates)),
  };
};

const loadAllCardTemplates = (): Record<string, CardTemplate> => {
  const templates: Record<string, CardTemplate> = {};
  const files = ['monster.json', 'party_leader.json', 'hero.json', 'item.json', 'magic.json', 'modifier.json', 'challenge.json', 'cursed_item.json'];
  
  for (const file of files) {
    const raw = readFileSync(join(cardsDir, file), 'utf8');
    const json = JSON.parse(raw) as Record<string, CardTemplate>;
    Object.assign(templates, json);
  }
  
  return templates;
};

type AbilityPromptType = 'selectPlayer' | 'selectCard' | 'discardCard' | 'confirm';

interface AbilityPromptOption {
  id: string;
  label: string;
  payload?: {
    playerId?: string;
    cardInstanceId?: string;
    [key: string]: unknown;
  };
}

interface AbilityPromptRequest {
  promptId: string;
  roomCode: string;
  heroInstanceId: string;
  sourcePlayerId: string;
  promptType: AbilityPromptType;
  message: string;
  options: AbilityPromptOption[];
  effect: any;
  remainingEffects: any[];
}

const abilityPromptRequests = new Map<string, AbilityPromptRequest>();

const getSocketByPlayerId = (playerId: string) => io.sockets.sockets.get(playerId);

const emitAbilityPrompt = (playerId: string, prompt: AbilityPromptRequest) => {
  const targetSocket = getSocketByPlayerId(playerId);
  if (!targetSocket) return;
  abilityPromptRequests.set(prompt.promptId, prompt);
  targetSocket.emit('abilityPrompt', {
    promptId: prompt.promptId,
    heroInstanceId: prompt.heroInstanceId,
    promptType: prompt.promptType,
    message: prompt.message,
    options: prompt.options,
    requesterId: prompt.sourcePlayerId,
  });
};

const emitAbilityResolution = (socket: Socket<ClientToServerEvents, ServerToClientEvents>, heroInstanceId: string, message: string) => {
  socket.emit('abilityResolution', { heroInstanceId, message });
};

const buildPromptId = () => randomUUID();

const moveCardBetweenZones = (
  sourceZone: CardInstance[],
  destinationZone: CardInstance[],
  cardInstanceId: string
) => {
  const index = sourceZone.findIndex((card) => card.instanceId === cardInstanceId);
  if (index === -1) return undefined;
  const [card] = sourceZone.splice(index, 1);
  if (card) destinationZone.push(card);
  return card;
};

const getPlayerBySocketId = (gameState: GameState, socketId: string) => gameState.players[socketId];

const findHeroInPlayerParty = (player: Player | undefined, heroInstanceId: string) => player?.zones.party.find((card) => card.instanceId === heroInstanceId && card.cardType === 'hero');

interface PlayerModifier {
  modifierType: string;
  amount: number;
  duration: number;
}

const getPlayerRollBonus = (player: Player): number => {
  const modifiers = (player as any).temporaryModifiers as PlayerModifier[] | undefined;
  if (!Array.isArray(modifiers)) return 0;
  return modifiers.reduce((total, modifier) => {
    if (modifier.modifierType === 'ROLL_BONUS' && typeof modifier.amount === 'number') {
      return total + modifier.amount;
    }
    return total;
  }, 0);
};

const decrementTemporaryModifiers = (player: Player) => {
  const modifiers = (player as any).temporaryModifiers as PlayerModifier[] | undefined;
  if (!Array.isArray(modifiers)) return;
  const remainingModifiers = modifiers
    .map((modifier) => ({ ...modifier, duration: (modifier.duration ?? 0) - 1 }))
    .filter((modifier) => modifier.duration > 0);
  if (remainingModifiers.length > 0) {
    (player as any).temporaryModifiers = remainingModifiers;
  } else {
    delete (player as any).temporaryModifiers;
  }
};

const isOpponent = (playerId: string, activePlayerId: string) => playerId !== activePlayerId;

const getOpponentPlayerIds = (gameState: GameState, activePlayerId: string) =>
  Object.keys(gameState.players).filter((playerId) => playerId !== activePlayerId);

const promptForPlayerSelection = (
  sourceSocket: Socket<ClientToServerEvents, ServerToClientEvents>,
  gameState: GameState,
  heroInstanceId: string,
  effect: any,
  eligiblePlayerIds: string[],
  message: string
) => {
  const options = eligiblePlayerIds.map((playerId) => ({
    id: playerId,
    label: gameState.players[playerId]?.username || 'Player',
    payload: { playerId },
  }));

  emitAbilityPrompt(sourceSocket.id, {
    promptId: buildPromptId(),
    roomCode: sourceSocket.data.roomCode as string,
    heroInstanceId,
    sourcePlayerId: sourceSocket.id,
    promptType: 'selectPlayer',
    message,
    options,
    effect,
    remainingEffects: [],
  });
};

const promptForCardSelection = (
  sourceSocket: Socket<ClientToServerEvents, ServerToClientEvents>,
  gameState: GameState,
  heroInstanceId: string,
  effect: any,
  cardOptions: CardInstance[],
  message: string
) => {
  const options = cardOptions.map((card) => ({
    id: card.instanceId,
    label: `${gameState.cardTemplates[card.templateId]?.name || card.templateId} (${card.cardType})`,
    payload: { cardInstanceId: card.instanceId },
  }));

  emitAbilityPrompt(sourceSocket.id, {
    promptId: buildPromptId(),
    roomCode: sourceSocket.data.roomCode as string,
    heroInstanceId,
    sourcePlayerId: sourceSocket.id,
    promptType: 'selectCard',
    message,
    options,
    effect,
    remainingEffects: [],
  });
};

const processHeroAbilityEffects = (
  sourceSocket: Socket<ClientToServerEvents, ServerToClientEvents>,
  gameState: GameState,
  player: Player,
  hero: CardInstance,
  template: CardTemplate,
  effects: any[],
  responsePayload?: { playerId?: string; cardInstanceId?: string }
): string | undefined => {
  const messages: string[] = [];
  for (const effect of effects) {
    let effectResult: string | undefined;
    switch (effect.action) {
      case 'DRAW': {
        // Skip DRAW if we're responding to a later effect's prompt (e.g., PLAY_FROM_HAND)
        // to avoid re-executing it multiple times
        if (responsePayload?.cardInstanceId) {
          break;
        }
        const amount = effect.amount ?? 1;
        const cards = drawCards(gameState.mainDeck, amount);
        player.zones.hand.push(...cards);
        effectResult = `Drew ${cards.length} card${cards.length === 1 ? '' : 's'} from the main deck.`;
        break;
      }
      case 'MOVE_CARD': {
        const targetZone = effect.destination === 'hand' ? player.zones.hand : player.zones.discardPile;
        const sourceZone = effect.source === 'discard_pile' ? gameState.discardPile : player.zones.discardPile;
        if (responsePayload?.cardInstanceId) {
          const card = moveCardBetweenZones(sourceZone, targetZone, responsePayload.cardInstanceId);
          if (!card) {
            return 'Could not move selected card.';
          }
          return `${gameState.cardTemplates[card.templateId]?.name || 'Card'} moved to ${effect.destination}.`;
        }

        const candidates = sourceZone.filter((card) => {
          if (effect.cardType && card.templateId) {
            const template = gameState.cardTemplates[card.templateId];
            return template?.type?.toLowerCase() === effect.cardType?.toLowerCase();
          }
          return true;
        });

        if (candidates.length === 0) {
          return 'No valid cards available to move.';
        }

        promptForCardSelection(sourceSocket, gameState, hero.instanceId, effect, candidates, 'Choose a card to move.');
        break;
      }
      case 'PROMPT_DISCARD': {
        // If this is a response to a previously emitted prompt, perform the discard now.
        if (responsePayload?.cardInstanceId) {
          const card = moveCardBetweenZones(player.zones.hand, player.zones.discardPile, responsePayload.cardInstanceId);
          if (!card) {
            return 'Could not discard selected card.';
          }
          return `Discarded ${gameState.cardTemplates[card.templateId]?.name || card.templateId}.`;
        }
        if (effect.target === 'all_opponents') {
          for (const opponentId of getOpponentPlayerIds(gameState, sourceSocket.id)) {
            const opponentSocket = getSocketByPlayerId(opponentId);
            if (!opponentSocket) continue;

            const opponent = gameState.players[opponentId];
            if (!opponent) continue;

            // If the effect has a condition (e.g., HAS_CARD_IN_ZONE), skip opponents who don't meet it
            if (effect.condition && effect.condition.type === 'HAS_CARD_IN_ZONE') {
              const zone = effect.condition.zone as keyof typeof opponent.zones;
              const requiredClass = (effect.condition.class || effect.condition.cardClass) as string | undefined;
              const hasCard = !!opponent.zones[zone]?.some((card) => {
                const tmpl = gameState.cardTemplates[card.templateId];
                return requiredClass ? tmpl?.class?.toLowerCase() === requiredClass?.toLowerCase() : true;
              });
              if (!hasCard) {
                // notify that this opponent is not affected
                opponentSocket.emit('abilityResolution', { heroInstanceId: hero.instanceId, message: 'Not affected by this ability.' });
                continue;
              }
            }

            const options = opponent.zones.hand.map((card) => ({
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
              sourcePlayerId: sourceSocket.id,
              promptType: 'discardCard',
              message: `Discard ${effect.amount ?? 1} card${(effect.amount === 1) ? '' : 's'}.`,
              options,
              effect,
              remainingEffects: [],
            });
            opponentSocket.emit('abilityPrompt', {
              promptId,
              heroInstanceId: hero.instanceId,
              promptType: 'discardCard',
              message: `Discard ${effect.amount ?? 1} card${(effect.amount === 1) ? '' : 's'}.`,
              options,
              requesterId: sourceSocket.id,
            });
          }
          return `Prompting opponents to discard ${effect.amount ?? 1} card${(effect.amount === 1) ? '' : 's'}.`;
        }

        if (effect.target === 'selected_player') {
          if (responsePayload?.playerId) {
            const targetPlayer = gameState.players[responsePayload.playerId];
            if (!targetPlayer) return 'Selected player not found.';

            const targetSocket = getSocketByPlayerId(responsePayload.playerId);
            if (!targetSocket) return 'Selected player not connected.';

            const options = targetPlayer.zones.hand.map((card) => ({
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
              sourcePlayerId: sourceSocket.id,
              promptType: 'discardCard',
              message: `Discard ${effect.amount ?? 1} card${(effect.amount === 1) ? '' : 's'}.`,
              options,
              effect,
              remainingEffects: [],
            });
            targetSocket.emit('abilityPrompt', {
              promptId,
              heroInstanceId: hero.instanceId,
              promptType: 'discardCard',
              message: `Discard ${effect.amount ?? 1} card${(effect.amount === 1) ? '' : 's'}.`,
              options,
              requesterId: sourceSocket.id,
            });
            return `Prompting ${targetPlayer.username || 'Player'} to discard ${effect.amount ?? 1} card${(effect.amount === 1) ? '' : 's'}.`;
          }

          const eligiblePlayers = Object.keys(gameState.players).filter((id) => isOpponent(id, sourceSocket.id));
          if (eligiblePlayers.length === 0) {
            return 'No eligible players available.';
          }
          promptForPlayerSelection(sourceSocket, gameState, hero.instanceId, effect, eligiblePlayers, 'Choose a player for this effect.');
          break;
        }

        return 'Unsupported discard target.';
      }
      case 'PROMPT_SACRIFICE': {
        if (effect.target === 'all_opponents') {
          for (const opponentId of getOpponentPlayerIds(gameState, sourceSocket.id)) {
            const opponentSocket = getSocketByPlayerId(opponentId);
            if (!opponentSocket) continue;

            const opponent = gameState.players[opponentId];
            if (!opponent) continue;

            const options = opponent.zones.party.map((card) => ({
              id: card.instanceId,
              label: gameState.cardTemplates[card.templateId]?.name || card.templateId,
              payload: { cardInstanceId: card.instanceId },
            }));

            if (options.length === 0) {
              opponentSocket.emit('abilityResolution', { heroInstanceId: hero.instanceId, message: 'No hero cards to sacrifice.' });
              continue;
            }

            const promptId = buildPromptId();
            abilityPromptRequests.set(promptId, {
              promptId,
              roomCode: sourceSocket.data.roomCode as string,
              heroInstanceId: hero.instanceId,
              sourcePlayerId: sourceSocket.id,
              promptType: 'discardCard',
              message: `Sacrifice a hero card from your party.`,
              options,
              effect,
              remainingEffects: [],
            });
            opponentSocket.emit('abilityPrompt', {
              promptId,
              heroInstanceId: hero.instanceId,
              promptType: 'discardCard',
              message: `Sacrifice a hero card from your party.`,
              options,
              requesterId: sourceSocket.id,
            });
          }
          return `Prompting opponents to sacrifice a hero card.`;
        }
        return 'Unsupported sacrifice target.';
      }
      case 'SLAY': {
        if (effect.target === 'selected') {
          const candidates = gameState.activeMonsters;
          if (candidates.length === 0) return 'No monsters available to slay.';
          promptForCardSelection(sourceSocket, gameState, hero.instanceId, effect, candidates, 'Choose a monster to SLAY.');
          break;
        }
        return 'Unsupported SLAY target.';
      }
      case 'APPLY_ROOM_FLAG': {
        // Room flags are not fully modeled yet, but we can note the ability activation.
        return `Applied room flag: ${(effect.flag as string) || 'unknown'}.`;
      }
      case 'APPLY_PLAYER_MODIFIER': {
        const playerModifiers = (player as any).temporaryModifiers ?? [];
        playerModifiers.push({ modifierType: effect.modifierType, amount: effect.amount ?? 0, duration: effect.duration ?? 1 });
        (player as any).temporaryModifiers = playerModifiers;
        return `Applied modifier: ${effect.modifierType} ${effect.amount}.`;
      }
      case 'VIEW_HAND': {
        if (responsePayload?.playerId) {
          const targetPlayer = gameState.players[responsePayload.playerId];
          if (!targetPlayer) return 'Player not found.';
          const cardNames = targetPlayer.zones.hand.map((card) => gameState.cardTemplates[card.templateId]?.name || card.templateId);
          return `Player ${targetPlayer.username || 'Player'} has: ${cardNames.join(', ') || 'no cards'}.`;
        }
        const eligiblePlayers = Object.keys(gameState.players).filter((id) => isOpponent(id, sourceSocket.id));
        promptForPlayerSelection(sourceSocket, gameState, hero.instanceId, effect, eligiblePlayers, 'Choose a player whose hand to view.');
        break;
      }
      case 'STEAL_RANDOM_CARD': {
        if (effect.target === 'all_opponents') {
          const opponents = getOpponentPlayerIds(gameState, sourceSocket.id).filter((playerId) => {
            if (!effect.condition) return true;
            const opponent = gameState.players[playerId];
            if (!opponent) return false;
            if (effect.condition.type === 'HAS_CARD_IN_ZONE') {
              return opponent.zones[effect.condition.zone as keyof typeof opponent.zones]?.some((card) => {
                const template = gameState.cardTemplates[card.templateId];
                return template?.class?.toLowerCase() === effect.condition.cardClass?.toLowerCase();
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
          return `Stole ${stolenCards.length} card${stolenCards.length === 1 ? '' : 's'}: ${stolenCards.join(', ')}.`;
        }

        if (effect.target === 'target_owner' && responsePayload?.playerId) {
          const targetPlayer = gameState.players[responsePayload.playerId];
          if (!targetPlayer || targetPlayer.zones.hand.length === 0) return 'No valid hand to steal from.';
          const cardIndex = Math.floor(Math.random() * targetPlayer.zones.hand.length);
          const [card] = targetPlayer.zones.hand.splice(cardIndex, 1);
          if (!card) return 'Failed to steal a card.';
          player.zones.hand.push(card);
          return `Stole ${gameState.cardTemplates[card.templateId]?.name || card.templateId} from ${targetPlayer.username || 'player'}.`;
        }
        return 'Unsupported steal action.';
      }
      case 'PLAY_FROM_HAND': {
        const candidates = player.zones.hand.filter((card) => card.cardType === (effect.cardType as string));
        if (candidates.length === 0) {
          effectResult = `No ${effect.cardType} cards available to play.`;
          break;
        }
        if (responsePayload?.cardInstanceId) {
          const index = player.zones.hand.findIndex((card) => card.instanceId === responsePayload.cardInstanceId);
          if (index === -1) {
            effectResult = 'Selected card not found in hand.';
            break;
          }
          const [card] = player.zones.hand.splice(index, 1);
          if (!card) {
            effectResult = 'Selected card not found in hand.';
            break;
          }
          player.zones.party.push(card);
          sourceSocket.emit('heroPlayedFromAbility', card.instanceId);
          effectResult = `Played ${gameState.cardTemplates[card.templateId]?.name || card.templateId} from your hand.`;
          break;
        }
        promptForCardSelection(sourceSocket, gameState, hero.instanceId, effect, candidates, 'Choose a hero card from your hand to play.');
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

const activateHeroAbility = (
  sourceSocket: Socket<ClientToServerEvents, ServerToClientEvents>,
  gameState: GameState,
  heroInstanceId: string,
  sendRoomUpdate: () => void
) => {
  const player = getPlayerBySocketId(gameState, sourceSocket.id);
  if (!player) {
    sourceSocket.emit('actionFailed', 'Player not found.');
    return;
  }

  const hero = findHeroInPlayerParty(player, heroInstanceId);
  if (!hero) {
    sourceSocket.emit('actionFailed', 'Hero not found in your party.');
    return;
  }

  const template = gameState.cardTemplates[hero.templateId] as any;
  if (!template || !template.activeSkill || !Array.isArray(template.activeSkill.effects)) {
    sourceSocket.emit('actionFailed', 'This hero has no ability to activate.');
    return;
  }

  const result = processHeroAbilityEffects(sourceSocket, gameState, player, hero, template, template.activeSkill.effects);
  
  // Check if a prompt was just emitted (waiting for user input)
  // If so, don't call emitAbilityResolution yet; let handlePromptResponse handle it
  const pendingPrompts = Array.from(abilityPromptRequests.values()).filter(
    (req) => req.heroInstanceId === heroInstanceId && req.sourcePlayerId === sourceSocket.id
  );
  
  if (result && pendingPrompts.length === 0) {
    hero.effectUsedThisTurn = true;
    emitAbilityResolution(sourceSocket, heroInstanceId, result);
    sendRoomUpdate();
  } else if (pendingPrompts.length === 0) {
    // No result and no pending prompts; mark as used and send update
    hero.effectUsedThisTurn = true;
    sendRoomUpdate();
  }
  // If there are pending prompts, handlePromptResponse will handle marking as used and sending resolution
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

  const responsePayload = option.payload as { playerId?: string; cardInstanceId?: string } | undefined;
  const sourcePlayer = getPlayerBySocketId(gameState, request.sourcePlayerId);
  if (!sourcePlayer) {
    sourceSocket.emit('actionFailed', 'Ability source player not found.');
    return;
  }

  const sourceHero = findHeroInPlayerParty(sourcePlayer, request.heroInstanceId);
  if (!sourceHero) {
    sourceSocket.emit('actionFailed', 'Source hero not found when resolving prompt.');
    return;
  }

  const template = gameState.cardTemplates[sourceHero.templateId] as any;
  if (!template || !template.activeSkill || !Array.isArray(template.activeSkill.effects)) {
    sourceSocket.emit('actionFailed', 'Hero ability could not be resolved.');
    return;
  }

  const result = processHeroAbilityEffects(sourceSocket, gameState, player, sourceHero, template, [request.effect], responsePayload);
  
  // Check if there are more prompts pending for this ability
  const pendingPrompts = Array.from(abilityPromptRequests.values()).filter(
    (req) => req.heroInstanceId === sourceHero.instanceId && req.sourcePlayerId === request.sourcePlayerId
  );
  
  // Only mark as used and emit resolution if no more prompts are pending
  if (pendingPrompts.length === 0) {
    sourceHero.effectUsedThisTurn = true;
    if (result) {
      emitAbilityResolution(sourceSocket, sourceHero.instanceId, result);
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
};

const app = express();
app.use(cors());
app.use(express.json());

const rooms: Record<string, GameState> = {};

const generateRoomCode = (): string => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
};

const createInitialGameState = (roomCode: string): GameState => ({
  gameId: roomCode,
  status: 'waiting',
  activePlayerId: '',
  turnNumber: 0,
  phase: 'DRAW',
  players: {},
  stack: [],
  monsterDeck: [],
  partyLeaderDeck: [],
  mainDeck: [],
  activeMonsters: [],
  discardedMonsters: [],
  discardPile: [],
  cardTemplates: loadAllCardTemplates(),
  diceRolls: {},
  availablePartyLeaderCards: [],
  partyLeaderSelectionOrder: [],
  currentSelectionPlayerId: undefined,
  rollWinnerId: undefined,
  lobbyLeaderId: undefined,
  currentRollerId: undefined,
  firstPlayerId: undefined,
  targetMonstersToWin: undefined
});

const getRoomState = (roomCode?: string) => roomCode ? rooms[roomCode] : undefined;

app.post('/api/create-room', (_req, res) => {
  let roomCode = generateRoomCode();
  while (rooms[roomCode]) {
    roomCode = generateRoomCode();
  }
  rooms[roomCode] = createInitialGameState(roomCode);
  res.json({ roomCode });
});

app.get('/api/room/:roomCode', (req, res) => {
  const roomCode = req.params.roomCode?.toUpperCase();
  res.json({ exists: Boolean(getRoomState(roomCode)) });
});

const httpServer = createServer(app);

// Apply the types to the Socket Server
const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  cors: {
    origin: "http://localhost:5173",
    methods: ["GET", "POST"]
  }
});

io.on('connection', (socket: Socket) => {
  const roomCode = (socket.handshake.auth.roomCode as string | undefined)?.toUpperCase();
  const username = socket.handshake.auth.username as string | undefined;
  const gameState = getRoomState(roomCode);

  if (!roomCode || !gameState) {
    socket.emit('actionFailed', 'Room not found or room code missing.');
    socket.disconnect();
    return;
  }

  socket.data.roomCode = roomCode;
  socket.join(roomCode);

  const player = gameState.players[socket.id];
  if (!player) {
    gameState.players[socket.id] = {
      id: socket.id,
      username,
      actionPoints: 3,
      partyLeaderId: undefined,
      zones: {
        hand: [],
        party: [],
        discardPile: []
      }
    };
  } else if (username) {
    player.username = username;
  }

  if (!gameState.activePlayerId) {
    gameState.activePlayerId = socket.id;
  }

  if (!gameState.lobbyLeaderId) {
    gameState.lobbyLeaderId = socket.id;
  }

  const sendRoomUpdate = () => {
    const current = getRoomState(roomCode);
    if (!current) return;
    io.to(roomCode).emit('stateUpdate', current);
    io.to(roomCode).emit('playersUpdated', Object.values(current.players));
  };

  sendRoomUpdate();

  socket.on('startGame', () => {
    const gameState = getRoomState(socket.data.roomCode as string);
    if (!gameState || gameState.status !== 'waiting') {
      return;
    }

    if (Object.keys(gameState.players).length === 0) {
      return;
    }

    const { monsterDeck, partyLeaderDeck, mainDeck } = initializeDecks();
    gameState.monsterDeck = monsterDeck;
    gameState.partyLeaderDeck = partyLeaderDeck;
    gameState.mainDeck = mainDeck;
    gameState.discardPile = [];
    gameState.discardedMonsters = [];
    gameState.activeMonsters = drawCards(gameState.monsterDeck, 3) as MonsterInstance[];

    const playerIds = Object.keys(gameState.players);
    for (const playerId of playerIds) {
      const player = gameState.players[playerId];
      if (!player) continue;
      const cards = drawCards(gameState.mainDeck, 5);
      player.zones.hand.push(...cards);
    }

    gameState.status = 'rolling';
    gameState.diceRolls = {};
    gameState.availablePartyLeaderCards = [];
    gameState.partyLeaderSelectionOrder = [];
    gameState.currentSelectionPlayerId = undefined;
    gameState.currentRollerId = playerIds[0] ?? undefined;
    gameState.turnNumber = 0;

    sendRoomUpdate();
  });

  socket.on('drawFromMain', () => {
    const gameState = getRoomState(socket.data.roomCode as string);
    if (!gameState) return;

    if (gameState.status !== 'in_progress') {
      socket.emit('actionFailed', 'Cannot draw now.');
      return;
    }

    const player = gameState.players[socket.id];
    if (!player) return;

    if (socket.id !== gameState.activePlayerId) {
      socket.emit('actionFailed', 'Not your turn to draw.');
      return;
    }

    if ((player.actionPoints ?? 0) < 1) {
      socket.emit('actionFailed', 'Not enough AP to draw a card.');
      return;
    }

    if (gameState.mainDeck.length === 0) {
      socket.emit('actionFailed', 'No cards to draw.');
      return;
    }

    const card = drawCards(gameState.mainDeck, 1)[0];
    if (!card) return;

    player.zones.hand.push(card);
    player.actionPoints = (player.actionPoints ?? 0) - 1;

    socket.emit('cardDrawn', { instanceId: card.instanceId, templateId: card.templateId });
    sendRoomUpdate();
  });

  socket.on('playHero', (instanceId) => {
    const gameState = getRoomState(socket.data.roomCode as string);
    if (!gameState) return;

    if (gameState.status !== 'in_progress') {
      socket.emit('actionFailed', 'Cannot play hero now.');
      return;
    }

    if (socket.id !== gameState.activePlayerId) {
      socket.emit('actionFailed', 'Not your turn.');
      return;
    }

    const player = gameState.players[socket.id];
    if (!player) return;

    if ((player.actionPoints ?? 0) < 1) {
      socket.emit('actionFailed', 'Not enough AP to play a hero.');
      return;
    }

    const cardIndex = player.zones.hand.findIndex((card) => card.instanceId === instanceId);
    if (cardIndex === -1) {
      socket.emit('actionFailed', 'Hero card not found in hand.');
      return;
    }

    const card = player.zones.hand[cardIndex];
    if (!card || card.cardType !== 'hero') {
      socket.emit('actionFailed', 'Only hero cards can be played to your party.');
      return;
    }

    const playedCards = player.zones.hand.splice(cardIndex, 1);
    const playedCard = playedCards[0];
    if (!playedCard) {
      socket.emit('actionFailed', 'Failed to play hero card.');
      return;
    }

    player.zones.party.push(playedCard);
    player.actionPoints = (player.actionPoints ?? 0) - 1;

    sendRoomUpdate();
  });

  socket.on('playItem', (itemInstanceId, targetHeroInstanceId) => {
    const gameState = getRoomState(socket.data.roomCode as string);
    if (!gameState) return;

    if (gameState.status !== 'in_progress') {
      socket.emit('actionFailed', 'Cannot play item now.');
      return;
    }

    if (socket.id !== gameState.activePlayerId) {
      socket.emit('actionFailed', 'Not your turn.');
      return;
    }

    const player = gameState.players[socket.id];
    if (!player) return;

    if ((player.actionPoints ?? 0) < 1) {
      socket.emit('actionFailed', 'Not enough AP to play an item.');
      return;
    }

    const itemIndex = player.zones.hand.findIndex((card) => card.instanceId === itemInstanceId);
    if (itemIndex === -1) {
      socket.emit('actionFailed', 'Item not found in hand.');
      return;
    }

    const itemCard = player.zones.hand[itemIndex];
    if (!itemCard || itemCard.cardType !== 'item') {
      socket.emit('actionFailed', 'Only item cards can be equipped to heroes.');
      return;
    }

    const itemTemplate = gameState.cardTemplates[itemCard.templateId];
    if ((itemTemplate?.subtype as string | undefined)?.toLowerCase() === 'cursed') {
      socket.emit('actionFailed', 'Cursed items must be played on opponents using the cursed item flow.');
      return;
    }

    const targetHero = player.zones.party.find((card) => card.instanceId === targetHeroInstanceId);
    if (!targetHero) {
      socket.emit('actionFailed', 'Target hero not found in your party.');
      return;
    }

    if (targetHero.equippedItem) {
      socket.emit('actionFailed', 'That hero already has an equipped item.');
      return;
    }

    const [removedItems] = player.zones.hand.splice(itemIndex, 1);
    if (!removedItems) {
      socket.emit('actionFailed', 'Failed to remove item from hand.');
      return;
    }

    targetHero.equippedItem = removedItems.instanceId;
    player.actionPoints = (player.actionPoints ?? 0) - 1;

    sendRoomUpdate();
  });

  socket.on('playCursedItem', (itemInstanceId, targetPlayerId, targetHeroInstanceId) => {
    const gameState = getRoomState(socket.data.roomCode as string);
    if (!gameState) return;

    if (gameState.status !== 'in_progress') {
      socket.emit('actionFailed', 'Cannot play cursed item now.');
      return;
    }

    if (socket.id !== gameState.activePlayerId) {
      socket.emit('actionFailed', 'Not your turn.');
      return;
    }

    if (socket.id === targetPlayerId) {
      socket.emit('actionFailed', 'Cannot play cursed item on your own heroes.');
      return;
    }

    const player = gameState.players[socket.id];
    if (!player) return;

    const targetPlayer = gameState.players[targetPlayerId];
    if (!targetPlayer) {
      socket.emit('actionFailed', 'Target player not found.');
      return;
    }

    if ((player.actionPoints ?? 0) < 1) {
      socket.emit('actionFailed', 'Not enough AP to play a cursed item.');
      return;
    }

    const itemIndex = player.zones.hand.findIndex((card) => card.instanceId === itemInstanceId);
    if (itemIndex === -1) {
      socket.emit('actionFailed', 'Cursed item not found in hand.');
      return;
    }

    const itemCard = player.zones.hand[itemIndex];
    if (!itemCard || itemCard.cardType !== 'item') {
      socket.emit('actionFailed', 'Only item cards can be equipped to heroes.');
      return;
    }

    const itemTemplate = gameState.cardTemplates[itemCard.templateId];
    if ((itemTemplate?.subtype as string | undefined)?.toLowerCase() !== 'cursed') {
      socket.emit('actionFailed', 'Only cursed items can be played on opponent heroes.');
      return;
    }

    const targetHero = targetPlayer.zones.party.find((card) => card.instanceId === targetHeroInstanceId);
    if (!targetHero) {
      socket.emit('actionFailed', 'Target hero not found in opponent\'s party.');
      return;
    }

    if (targetHero.equippedItem) {
      socket.emit('actionFailed', 'That hero already has an equipped item.');
      return;
    }

    const [removedItems] = player.zones.hand.splice(itemIndex, 1);
    if (!removedItems) {
      socket.emit('actionFailed', 'Failed to remove cursed item from hand.');
      return;
    }

    targetHero.equippedItem = removedItems.instanceId;
    player.actionPoints = (player.actionPoints ?? 0) - 1;

    sendRoomUpdate();
  });

  socket.on('rollHeroAbility', (heroInstanceId) => {
    const gameState = getRoomState(socket.data.roomCode as string);
    if (!gameState) return;

    console.log("GameState: ", gameState);

    if (gameState.status !== 'in_progress') {
      console.log("Cannot roll hero ability now.", gameState.status);
      socket.emit('actionFailed', 'Cannot roll hero ability now.');
      return;
    }

    if (socket.id !== gameState.activePlayerId) {
      console.log('Not your turn.');
      socket.emit('actionFailed', 'Not your turn.');
      return;
    }

    const player = gameState.players[socket.id];
    if (!player) return;

    const hero = player.zones.party.find((card) => card.instanceId === heroInstanceId);
    if (!hero || hero.cardType !== 'hero') {
      console.log('Hero not found in your party.');
      socket.emit('actionFailed', 'Hero not found in your party.');
      return;
    }

    const template = gameState.cardTemplates[hero.templateId];
    const requiredRoll = (template?.rollToPlay as number | undefined) ?? 0;
    const die1 = Math.floor(Math.random() * 6) + 1;
    const die2 = Math.floor(Math.random() * 6) + 1;
      const rollBonus = getPlayerRollBonus(player);
      const total = die1 + die2;
      const totalWithBonus = total + rollBonus;
      const success = totalWithBonus >= requiredRoll;
      const message = `Rolled ${die1} + ${die2}${rollBonus ? ` + ${rollBonus}` : ''} = ${total + rollBonus}. ${success ? 'Success!' : 'Failed.'} (needed ${requiredRoll}).`;

    socket.emit('heroRollResult', {
      heroInstanceId,
      die1,
      die2,
        total: totalWithBonus,
      requiredRoll,
      success,
      message,
    });
  });

  socket.on('activateHeroAbility', (heroInstanceId) => {
    const gameState = getRoomState(socket.data.roomCode as string);
    if (!gameState || gameState.status !== 'in_progress') return;
    if (socket.id !== gameState.activePlayerId) {
      socket.emit('actionFailed', 'Not your turn.');
      return;
    }
    const player = gameState.players[socket.id];
    if (!player) return;

    // Deduct 1 AP for using ability from party
    if ((player.actionPoints ?? 0) < 1) {
      socket.emit('actionFailed', 'Not enough AP to activate a hero ability.');
      return;
    }
    player.actionPoints = (player.actionPoints ?? 0) - 1;

    activateHeroAbility(socket, gameState, heroInstanceId, sendRoomUpdate);
  });

  socket.on('respondToAbilityPrompt', (promptId, selectedOptionId) => {
    handlePromptResponse(socket, promptId, selectedOptionId, sendRoomUpdate);
  });

  socket.on('rollForFirst', () => {
    const gameState = getRoomState(socket.data.roomCode as string);
    if (!gameState || gameState.status !== 'rolling' || !gameState.currentRollerId) {
      return;
    }

    if (socket.id !== gameState.currentRollerId) {
      return;
    }

      const player = gameState.players[socket.id];
      if (!player) return;

    const die1 = Math.floor(Math.random() * 6) + 1;
    const die2 = Math.floor(Math.random() * 6) + 1;
    const total = die1 + die2;

    // Initial "roll for first" should not include any temporary roll bonuses.
    gameState.diceRolls[socket.id] = total;

    const playerIds = Object.keys(gameState.players);
    const rolledPlayerIds = Object.keys(gameState.diceRolls);
    const nextRollerIndex = playerIds.findIndex(id => !rolledPlayerIds.includes(id));

    if (nextRollerIndex >= 0) {
      gameState.currentRollerId = playerIds[nextRollerIndex] ?? undefined;
    } else {
      let maxRoll = 0;
      let winnerId = '';

      for (const [playerId, roll] of Object.entries(gameState.diceRolls)) {
        if (roll > maxRoll) {
          maxRoll = roll;
          winnerId = playerId;
        }
      }

      gameState.activePlayerId = winnerId;
      gameState.firstPlayerId = winnerId;
      gameState.currentRollerId = undefined;
      gameState.rollWinnerId = winnerId;
      gameState.turnNumber = 1;
      gameState.phase = 'DRAW';
      gameState.status = 'roll_complete';
    }

    sendRoomUpdate();
  });

  socket.on('continueGame', () => {
    const gameState = getRoomState(socket.data.roomCode as string);
    if (!gameState) return;

    if (gameState.status !== 'roll_complete' && gameState.status !== 'party_leader_review') {
      return;
    }

    if (socket.id !== gameState.lobbyLeaderId) {
      return;
    }

    if (gameState.status === 'roll_complete') {
      const allPlayerIds = Object.keys(gameState.players);
      const firstPlayer = gameState.firstPlayerId ?? allPlayerIds[0] ?? '';
      const selectionOrder = firstPlayer
        ? [firstPlayer, ...allPlayerIds.filter((id) => id !== firstPlayer)]
        : [...allPlayerIds];

      gameState.status = 'party_leader_selection';
      gameState.availablePartyLeaderCards = [...gameState.partyLeaderDeck];
      gameState.partyLeaderSelectionOrder = selectionOrder;
      gameState.currentSelectionPlayerId = selectionOrder[0];
      gameState.diceRolls = {};
    } else {
      gameState.status = 'in_progress';
      gameState.activePlayerId = gameState.firstPlayerId ?? Object.keys(gameState.players)[0] ?? '';
      for (const pid of Object.keys(gameState.players)) {
        const p = gameState.players[pid];
        if (!p) continue;
        p.actionPoints = 3;
      }
    }

    sendRoomUpdate();
  });

  socket.on('endTurn', () => {
    const gameState = getRoomState(socket.data.roomCode as string);
    if (!gameState || gameState.status !== 'in_progress') return;
    if (socket.id !== gameState.activePlayerId) return;

      const currentPlayer = gameState.players[socket.id];
      if (currentPlayer) {
        decrementTemporaryModifiers(currentPlayer);
      }

    const playerIds = Object.keys(gameState.players);
    if (playerIds.length === 0) return;

    const currentIndex = playerIds.findIndex((id) => id === socket.id);
    const nextIndex = (currentIndex + 1) % playerIds.length;
    const nextPlayerId = playerIds[nextIndex] ?? '';

    gameState.activePlayerId = nextPlayerId;
    gameState.turnNumber = (gameState.turnNumber ?? 0) + 1;

    const nextPlayer = nextPlayerId ? gameState.players[nextPlayerId] : undefined;
    if (nextPlayer) {
      nextPlayer.actionPoints = 3;
      // Reset ability usage flags for new active player
      nextPlayer.zones.party.forEach((card) => {
        card.effectUsedThisTurn = false;
      });
      nextPlayer.zones.hand.forEach((card) => {
        card.effectUsedThisTurn = false;
      });
    }

    sendRoomUpdate();
  });

  socket.on('choosePartyLeader', (instanceId) => {
    const gameState = getRoomState(socket.data.roomCode as string);
    if (!gameState || gameState.status !== 'party_leader_selection') {
      return;
    }

    if (socket.id !== gameState.currentSelectionPlayerId) {
      return;
    }

    const cardIndex = gameState.availablePartyLeaderCards.findIndex(
      (card) => card.instanceId === instanceId
    );

    if (cardIndex === -1) {
      return;
    }

    const chosenCard = gameState.availablePartyLeaderCards.splice(cardIndex, 1)[0];
    if (!chosenCard) {
      return;
    }
    const player = gameState.players[socket.id];
    if (!player) {
      return;
    }

    player.zones.party = [chosenCard];

    const currentIndex = gameState.partyLeaderSelectionOrder.findIndex(
      (id) => id === socket.id
    );
    const nextIndex = currentIndex + 1;

    if (nextIndex < gameState.partyLeaderSelectionOrder.length) {
      gameState.currentSelectionPlayerId = gameState.partyLeaderSelectionOrder[nextIndex];
    } else {
      gameState.currentSelectionPlayerId = undefined;
      gameState.status = 'party_leader_review';
      if (gameState.activeMonsters.length === 0) {
        gameState.activeMonsters = drawCards(gameState.monsterDeck, 3) as MonsterInstance[];
      }
    }

    sendRoomUpdate();
  });

  socket.on('quitGame', () => {
    const gameState = getRoomState(socket.data.roomCode as string);
    if (!gameState) return;

    gameState.status = 'waiting';
    gameState.activePlayerId = gameState.lobbyLeaderId || '';
    gameState.turnNumber = 0;
    gameState.phase = 'DRAW';
    gameState.stack = [];
    gameState.monsterDeck = [];
    gameState.partyLeaderDeck = [];
    gameState.mainDeck = [];
    gameState.activeMonsters = [];
    gameState.discardedMonsters = [];
    gameState.discardPile = [];
    gameState.diceRolls = {};
    gameState.currentRollerId = undefined;
    gameState.firstPlayerId = undefined;
    gameState.rollWinnerId = undefined;
    gameState.availablePartyLeaderCards = [];
    gameState.partyLeaderSelectionOrder = [];
    gameState.currentSelectionPlayerId = undefined;

    for (const playerId of Object.keys(gameState.players)) {
      const player = gameState.players[playerId];
      if (!player) continue;
      player.zones.hand = [];
      player.zones.party = [];
      player.zones.discardPile = [];
      player.actionPoints = 3;
      player.partyLeaderId = undefined;
    }

    sendRoomUpdate();
  });

  socket.on('pingServer', () => {
    socket.emit('pongClient', { message: 'Connection successful!' });
  });

  socket.on('setUsername', (username) => {
    const gameState = getRoomState(socket.data.roomCode as string);
    if (gameState) {
      const player = gameState.players[socket.id];
      if (player) {
        player.username = username;
      } else {
        gameState.players[socket.id] = {
          id: socket.id,
          username: username,
          actionPoints: 3,
          partyLeaderId: undefined,
          zones: {
            hand: [],
            party: [],
            discardPile: []
          }
        };
      }
      sendRoomUpdate();
    }
  });

  socket.on('disconnect', () => {
    const roomCode = socket.data.roomCode as string | undefined;
    if (!roomCode) return;

    const gameState = getRoomState(roomCode);
    if (!gameState) return;

    const wasLobbyLeader = socket.id === gameState.lobbyLeaderId;
    delete gameState.players[socket.id];

    if (gameState.activePlayerId === socket.id) {
      gameState.activePlayerId = Object.keys(gameState.players)[0] ?? '';
    }

    if (wasLobbyLeader) {
      gameState.lobbyLeaderId = Object.keys(gameState.players)[0] ?? undefined;
    }

    const room = io.sockets.adapter.rooms.get(roomCode);
    const roomCount = room?.size ?? 0;
    if (roomCount === 0) {
      delete rooms[roomCode];
      return;
    }

    sendRoomUpdate();
  });
});
const PORT = 3001;
httpServer.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});