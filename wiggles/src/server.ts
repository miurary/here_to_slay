import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

import type { ClientToServerEvents, ServerToClientEvents, CardInstance, CardTemplate, Effect, GameState, Player, MonsterInstance, PlayerState } from '../../shared/src/types.js'

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const cardsDir = join(__dirname, 'cards');


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

type AbilityPromptType = 'selectPlayer' | 'selectCard' | 'discardCard' | 'confirm' | 'multiSelectCard';

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
  effect: Effect;
  remainingEffects: Effect[];
  isItemTrigger?: boolean;
  itemInstanceId?: string;
  isMagicCard?: boolean;
  isChallengePrompt?: boolean;
  isMonsterEffect?: boolean;
  isPartyLeaderAbility?: boolean;
  isSlainPassive?: boolean;
  minSelections?: number;
  maxSelections?: number;
}

const abilityPromptRequests = new Map<string, AbilityPromptRequest>();
const heroesPlayedFromAbilityThisTurn = new Map<string, Set<string>>(); // roomCode → Set<heroInstanceId>

interface PendingChallengeState {
  pendingCardInstance: CardInstance;
  pendingPlayerId: string;
  pendingCardType: 'hero' | 'item' | 'magic';
  itemTargetPlayerId?: string;
  itemTargetHeroInstanceId?: string;
  magicSteps?: Effect[];
  eligibleChallengerIds: string[];
  passedPlayerIds: Set<string>;
  challengerId?: string;
  challengeCardInstanceId?: string;
  challengerRollBonus: number;
}
const pendingChallenges = new Map<string, PendingChallengeState>();

interface ModifierPhaseState {
  die1: number;
  die2: number;
  rawDiceTotal: number;
  persistentBonus: number;
  accumulatedModifier: number;
  requiredRoll: number;
  rollContext: 'HERO_ABILITY' | 'ATTACK_MONSTER';
  rollType: 'hero_ability' | 'monster_attack';
  heroInstanceId: string;
  rollingPlayerId: string;
  phase: 'roller_turn' | 'opponent_turn';
  allOpponentsWithModifiers: string[];
  opponentQueue: string[];
  cardPlayedThisCycle: boolean;
  modifiersPlayed: Array<{ playerName: string; cardName: string; amount: number; choiceLabel: string }>;
  monsterInstanceId?: string;
  lowerBound?: number;
}
const modifierPhases = new Map<string, ModifierPhaseState>();

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
    ...(prompt.minSelections !== undefined ? { minSelections: prompt.minSelections } : {}),
    ...(prompt.maxSelections !== undefined ? { maxSelections: prompt.maxSelections } : {}),
  });
};

const emitAbilityResolution = (socket: Socket<ClientToServerEvents, ServerToClientEvents>, heroInstanceId: string, message: string) => {
  socket.emit('abilityResolution', { heroInstanceId, message });
};

const buildPromptId = () => randomUUID();

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
  const targetSocket = getSocketByPlayerId(ownerPlayerId);
  if (!targetSocket) return;
  const roomCode = targetSocket.data.roomCode as string;

  for (const monster of player.slainMonsters ?? []) {
    const slain = gameState.cardTemplates[monster.templateId]?.slainEffect;
    if (!slain || slain.triggerEvent !== event) continue;
    const monsterName = gameState.cardTemplates[monster.templateId]?.name ?? 'A slain monster';

    // m_001 Doombringer — ON_SACRIFICE: choose a card from discard → hand.
    if (event === 'ON_SACRIFICE' && slain.action === 'PROMPT_SELECT') {
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

    // m_005 Rex Major — ON_DRAW_MODIFIER: optionally draw a second card.
    if (event === 'ON_DRAW_MODIFIER' && slain.action === 'DRAW_CARD') {
      if (gameState.mainDeck.length === 0) return;
      emitAbilityPrompt(ownerPlayerId, {
        promptId: buildPromptId(),
        roomCode,
        heroInstanceId: '',
        sourcePlayerId: ownerPlayerId,
        promptType: 'confirm',
        message: `${monsterName}: you drew a Modifier — draw a second card?`,
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
  for (const card of drawn) {
    if (card.cardType === 'modifier') {
      triggerSlainMonsterPassive(gameState, player.id, 'ON_DRAW_MODIFIER');
    }
  }
  return drawn;
};

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

const findHeroInPlayerParty = (player: Player | undefined, heroInstanceId: string) => player?.zones.party.find((card: CardInstance) => card.instanceId === heroInstanceId && card.cardType === 'hero');


const getPlayerRollBonus = (player: Player): number => {
  const modifiers = player.temporaryModifiers;
  if (!Array.isArray(modifiers)) return 0;
  return modifiers.reduce((total, modifier) => {
    if (modifier.modifierType === 'rollBonus' && typeof modifier.amount === 'number') {
      return total + modifier.amount;
    }
    return total;
  }, 0);
};

const decrementTemporaryModifiers = (player: Player) => {
  const modifiers = player.temporaryModifiers;
  if (!Array.isArray(modifiers)) return;
  const remainingModifiers = modifiers
    .map((modifier) => ({ ...modifier, duration: (modifier.duration ?? 0) - 1 }))
    .filter((modifier) => modifier.duration > 0);
  if (remainingModifiers.length > 0) {
    player.temporaryModifiers = remainingModifiers;
  } else {
    delete player.temporaryModifiers;
  }
};

const isOpponent = (playerId: string, activePlayerId: string) => playerId !== activePlayerId;

const getOpponentPlayerIds = (gameState: GameState, activePlayerId: string) =>
  Object.keys(gameState.players).filter((playerId) => playerId !== activePlayerId);

const getHeroEffectiveClass = (gameState: GameState, player: Player, hero: CardInstance): string | undefined => {
  const template = gameState.cardTemplates[hero.templateId];
  const baseClass = template?.class;
  if (!hero.equippedItem) return baseClass;
  const itemInstance = player.zones.party.find((c: CardInstance) => c.instanceId === hero.equippedItem);
  if (!itemInstance) return baseClass;
  const itemTemplate = gameState.cardTemplates[itemInstance.templateId];
  const passives = itemTemplate?.passiveModifiers;
  const classOverride = passives?.find(p => p.stat === 'class' && p.override);
  return classOverride?.override ?? baseClass;
};

const WIN_CLASSES = ['berserker', 'warrior', 'bard', 'guardian', 'ranger', 'thief', 'wizard'];

const checkWinCondition = (gameState: GameState, player: Player): boolean => {
  // Condition 1: enough monsters slain
  const slainCount = (player.slainMonsters ?? []).length;
  if (slainCount >= (gameState.targetMonstersToWin ?? 3)) return true;

  // Condition 2: one of each of the 7 party-leader classes represented in the party
  const partyClasses = new Set(
    player.zones.party
      .map((card: CardInstance) => getHeroEffectiveClass(gameState, player, card)?.toLowerCase())
      .filter((c: string | undefined): c is string => !!c)
  );
  return WIN_CLASSES.every(cls => partyClasses.has(cls));
};

const applyWinIfMet = (gameState: GameState, player: Player, playerId: string): boolean => {
  if (gameState.status === 'finished') return true;
  if (checkWinCondition(gameState, player)) {
    gameState.status = 'finished';
    gameState.winnerId = playerId;
    return true;
  }
  return false;
};

const promptForPlayerSelection = (
  sourceSocket: Socket<ClientToServerEvents, ServerToClientEvents>,
  gameState: GameState,
  heroInstanceId: string,
  effect: Effect,
  eligiblePlayerIds: string[],
  message: string,
  remainingEffects: Effect[] = []
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
    remainingEffects,
  });
};

const promptForCardSelection = (
  sourceSocket: Socket<ClientToServerEvents, ServerToClientEvents>,
  gameState: GameState,
  heroInstanceId: string,
  effect: Effect,
  cardOptions: CardInstance[],
  message: string,
  remainingEffects: Effect[] = []
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
    remainingEffects,
  });
};

const processHeroAbilityEffects = (
  sourceSocket: Socket<ClientToServerEvents, ServerToClientEvents>,
  gameState: GameState,
  player: Player,
  hero: CardInstance,
  template: CardTemplate,
  effects: Effect[],
  responsePayload?: { playerId?: string; cardInstanceId?: string }
): string | undefined => {
  const messages: string[] = [];
  let promptCreated = false;

  for (let i = 0; i < effects.length; i++) {
    if (promptCreated) break;
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
        const targetReq = template.targetRequirement;

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
          for (const opId of getOpponentPlayerIds(gameState, sourceSocket.id)) {
            const opp = gameState.players[opId];
            if (!opp) continue;
            const zone: CardInstance[] = targetReq.zone === 'party' ? opp.zones.party : opp.zones.hand;
            for (const card of zone) {
              if (!targetReq.cardType || card.cardType === targetReq.cardType) {
                allCandidates.push({ card, ownerId: opId });
              }
            }
          }
          if (allCandidates.length === 0) { effectResult = 'No valid cards available.'; break; }
          const opponentOptions = allCandidates.map(({ card, ownerId }) => ({
            id: card.instanceId,
            label: `${gameState.cardTemplates[card.templateId]?.name || card.templateId} (${gameState.players[ownerId]?.username || 'opponent'})`,
            payload: { cardInstanceId: card.instanceId, playerId: ownerId },
          }));
          emitAbilityPrompt(sourceSocket.id, {
            promptId: buildPromptId(),
            roomCode: sourceSocket.data.roomCode as string,
            heroInstanceId: hero.instanceId,
            sourcePlayerId: sourceSocket.id,
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
        if (candidates.length === 0) { effectResult = `No valid ${cardTypeFilter || ''} cards in the discard pile.`; break; }
        promptForCardSelection(sourceSocket, gameState, hero.instanceId, effect, candidates, 'Choose a card to move.', remainingAfterThis);
        promptCreated = true;
        break;
      }
      case 'PROMPT_DISCARD': {
        if (responsePayload?.cardInstanceId) {
          const card = moveCardBetweenZones(player.zones.hand, gameState.discardPile, responsePayload.cardInstanceId);
          if (!card) return 'Could not discard selected card.';
          return `Discarded ${gameState.cardTemplates[card.templateId]?.name || card.templateId}.`;
        }
        if (effect.target === 'all_opponents') {
          for (const opponentId of getOpponentPlayerIds(gameState, sourceSocket.id)) {
            const opponentSocket = getSocketByPlayerId(opponentId);
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
        if (effect.target === 'all_opponents') {
          for (const opponentId of getOpponentPlayerIds(gameState, sourceSocket.id)) {
            const opponentSocket = getSocketByPlayerId(opponentId);
            if (!opponentSocket) continue;
            const opponent = gameState.players[opponentId];
            if (!opponent) continue;
            const options = opponent.zones.party
              .filter((card: CardInstance) => card.cardType !== 'party_leader')
              .map((card: CardInstance) => ({
                id: card.instanceId,
                label: gameState.cardTemplates[card.templateId]?.name || card.templateId,
                payload: { cardInstanceId: card.instanceId },
              }));
            if (options.length === 0) {
              opponentSocket.emit('abilityResolution', { heroInstanceId: hero.instanceId, message: 'No cards to sacrifice.' });
              continue;
            }
            const promptId = buildPromptId();
            abilityPromptRequests.set(promptId, {
              promptId,
              roomCode: sourceSocket.data.roomCode as string,
              heroInstanceId: hero.instanceId,
              sourcePlayerId: sourceSocket.id,
              promptType: 'discardCard',
              message: 'Sacrifice a card from your party.',
              options,
              effect,
              remainingEffects: [],
            });
            opponentSocket.emit('abilityPrompt', {
              promptId,
              heroInstanceId: hero.instanceId,
              promptType: 'discardCard',
              message: 'Sacrifice a card from your party.',
              options,
              requesterId: sourceSocket.id,
            });
          }
          return 'Prompting opponents to sacrifice a card.';
        }
        return 'Unsupported sacrifice target.';
      }
      case 'SLAY': {
        if (responsePayload?.cardInstanceId) {
          const monsterIndex = gameState.activeMonsters.findIndex((m: MonsterInstance) => m.instanceId === responsePayload.cardInstanceId);
          if (monsterIndex === -1) { effectResult = 'Monster not found.'; break; }
          const [slain] = gameState.activeMonsters.splice(monsterIndex, 1);
          if (!slain) { effectResult = 'Failed to slay monster.'; break; }
          gameState.discardedMonsters.push(slain);
          if (gameState.activeMonsters.length < 3 && gameState.monsterDeck.length > 0) {
            gameState.activeMonsters.push(...(drawCards(gameState.monsterDeck, 1) as MonsterInstance[]));
          }
          effectResult = `Slew ${gameState.cardTemplates[slain.templateId]?.name || 'monster'}.`;
          break;
        }
        if (effect.target === 'selected') {
          if (gameState.activeMonsters.length === 0) { effectResult = 'No monsters available to slay.'; break; }
          const slayOptions = gameState.activeMonsters.map((m: MonsterInstance) => ({
            id: m.instanceId,
            label: gameState.cardTemplates[m.templateId]?.name || m.templateId,
            payload: { cardInstanceId: m.instanceId },
          }));
          emitAbilityPrompt(sourceSocket.id, {
            promptId: buildPromptId(),
            roomCode: sourceSocket.data.roomCode as string,
            heroInstanceId: hero.instanceId,
            sourcePlayerId: sourceSocket.id,
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
        playerModifiers.push({ modifierType: effect.modifierType ?? '', amount: effect.amount ?? 0, duration: effect.duration ?? 1 });
        player.temporaryModifiers = playerModifiers;
        effectResult = `Applied modifier: ${effect.modifierType} ${effect.amount}.`;
        break;
      }
      case 'VIEW_HAND': {
        if (responsePayload?.playerId) {
          const targetPlayer = gameState.players[responsePayload.playerId];
          if (!targetPlayer) return 'Player not found.';
          const cardNames = targetPlayer.zones.hand.map((card: CardInstance) => gameState.cardTemplates[card.templateId]?.name || card.templateId);
          return `${targetPlayer.username || 'Player'} has: ${cardNames.join(', ') || 'no cards'}.`;
        }
        const eligiblePlayers = Object.keys(gameState.players).filter((id) => isOpponent(id, sourceSocket.id));
        promptForPlayerSelection(sourceSocket, gameState, hero.instanceId, effect, eligiblePlayers, 'Choose a player whose hand to view.', remainingAfterThis);
        promptCreated = true;
        break;
      }
      case 'STEAL_RANDOM_CARD': {
        if (effect.target === 'all_opponents') {
          const opponents = getOpponentPlayerIds(gameState, sourceSocket.id).filter((playerId) => {
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
        const candidates = player.zones.hand.filter((card: CardInstance) => card.cardType === (effect.cardType as string));
        if (candidates.length === 0) { effectResult = `No ${effect.cardType} cards available to play.`; break; }
        if (responsePayload?.cardInstanceId) {
          const index = player.zones.hand.findIndex((card: CardInstance) => card.instanceId === responsePayload.cardInstanceId);
          if (index === -1) { effectResult = 'Selected card not found in hand.'; break; }
          const [card] = player.zones.hand.splice(index, 1);
          if (!card) { effectResult = 'Failed to play card from hand.'; break; }
          player.zones.party.push(card);
          applyWinIfMet(gameState, player, sourceSocket.id);
          const roomCode = sourceSocket.data.roomCode as string;
          if (!heroesPlayedFromAbilityThisTurn.has(roomCode)) heroesPlayedFromAbilityThisTurn.set(roomCode, new Set());
          heroesPlayedFromAbilityThisTurn.get(roomCode)!.add(card.instanceId);
          sourceSocket.emit('heroPlayedFromAbility', card.instanceId);
          effectResult = `Played ${gameState.cardTemplates[card.templateId]?.name || card.templateId} from your hand.`;
          break;
        }
        promptForCardSelection(sourceSocket, gameState, hero.instanceId, effect, candidates, 'Choose a hero card from your hand to play.', remainingAfterThis);
        promptCreated = true;
        break;
      }
      case 'SACRIFICE': {
        if (!responsePayload?.cardInstanceId) { effectResult = 'No card selected for sacrifice.'; break; }
        const sacrificeIndex = player.zones.party.findIndex((c: CardInstance) => c.instanceId === responsePayload.cardInstanceId);
        if (sacrificeIndex === -1) { effectResult = 'Selected card not found in party.'; break; }
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
        gameState.forceEndTurn = sourceSocket.id;
        effectResult = 'Ending turn.';
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
      emitAbilityPrompt(socket.id, {
        promptId: buildPromptId(),
        roomCode: socket.data.roomCode as string,
        heroInstanceId: hero.instanceId,
        sourcePlayerId: socket.id,
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
      emitAbilityPrompt(socket.id, {
        promptId: buildPromptId(),
        roomCode: socket.data.roomCode as string,
        heroInstanceId: hero.instanceId,
        sourcePlayerId: socket.id,
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
      emitAbilityPrompt(socket.id, {
        promptId: buildPromptId(),
        roomCode: socket.data.roomCode as string,
        heroInstanceId: hero.instanceId,
        sourcePlayerId: socket.id,
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
    default:
      return false;
  }
};

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

const getSlainMonsterHeroAbilityBonus = (gameState: GameState, player: Player): number =>
  (player.slainMonsters ?? []).reduce((total, m: CardInstance) => {
    const t = gameState.cardTemplates[m.templateId];
    if (
      t?.slainEffect?.action === 'PERSISTENT_MODIFIER' &&
      t.slainEffect.applies_to === 'HERO_ABILITY_ROLLS'
    ) return total + (t.slainEffect.modifier ?? 0);
    return total;
  }, 0);

const getMonsterAttackRollBonus = (gameState: GameState, player: Player): number => {
  if (!player.partyLeaderId) return 0;
  const leaderTemplate = gameState.cardTemplates[player.partyLeaderId];
  if (
    leaderTemplate?.effect?.triggerEvent === 'ON_ATTACK_ROLL' &&
    leaderTemplate.effect.action === 'APPLY_ROLL_MODIFIER'
  ) return leaderTemplate.effect.amount ?? 0;
  return 0;
};

const playerHasSlainEffectFlag = (gameState: GameState, player: Player, flag: string): boolean =>
  (player.slainMonsters ?? []).some((m: CardInstance) => {
    const t = gameState.cardTemplates[m.templateId];
    return t?.slainEffect?.flag === flag;
  });

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
    message: 'Sacrifice a Hero card (monster penalty).',
    options: heroOptions,
    effect: { action: 'MONSTER_SACRIFICE_HERO', monsterName, finalRoll, effectText },
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

  // Broadcast result immediately before any prompts
  io.to(roomCode).emit('monsterAttackResult', {
    attackerName: player.username ?? socket.id,
    monsterName,
    roll: finalTotal,
    requiredRoll: upperBound,
    slew: finalTotal >= upperBound,
    effectText: effectText || 'Nothing happens.',
  });

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
      promptMonsterSacrifice(socket, gameState, player, monster.instanceId, monsterName, finalTotal, effectText, sendRoomUpdate);
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
  const die1 = Math.floor(Math.random() * 6) + 1;
  const die2 = Math.floor(Math.random() * 6) + 1;
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

const finalizeRoll = (
  roomCode: string,
  phase: ModifierPhaseState,
  gameState: GameState,
  sendRoomUpdate: () => void
) => {
  const finalTotal = phase.rawDiceTotal + phase.persistentBonus + phase.accumulatedModifier;

  modifierPhases.delete(roomCode);
  delete gameState.modifierPhase;

  if (phase.rollType === 'monster_attack') {
    const monster = gameState.activeMonsters.find(m => m.instanceId === phase.monsterInstanceId);
    const player = gameState.players[phase.rollingPlayerId];
    const rollingSocket = getSocketByPlayerId(phase.rollingPlayerId);
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

  const rollingSocket = getSocketByPlayerId(phase.rollingPlayerId);
  if (rollingSocket) {
    rollingSocket.emit('heroRollResult', {
      heroInstanceId: phase.heroInstanceId,
      die1, die2,
      total: finalTotal,
      requiredRoll: phase.requiredRoll,
      success,
      message,
    });

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
    const newQueue = phase.allOpponentsWithModifiers.filter(
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
  const die1 = Math.floor(Math.random() * 6) + 1;
  const die2 = Math.floor(Math.random() * 6) + 1;
  const persistentBonus = getPlayerRollBonus(player) + preRollBonus
    + getPartyLeaderHeroAbilityBonus(gameState, socket.id)
    + getSlainMonsterHeroAbilityBonus(gameState, player);
  const rawDiceTotal = die1 + die2;
  const currentTotal = rawDiceTotal + persistentBonus;
  const roomCode = socket.data.roomCode as string;

  hero.effectUsedThisTurn = true;

  const opponentsWithModifiers = getOpponentsWithModifiers(gameState, socket.id);
  const rollerHasModifiers = player.zones.hand.some(c => c.cardType === 'modifier');
  const rollerNeedsPrompt = currentTotal < requiredRoll && rollerHasModifiers;

  if (!rollerNeedsPrompt && opponentsWithModifiers.length === 0) {
    const success = currentTotal >= requiredRoll;
    const message = `Rolled ${die1} + ${die2}${persistentBonus ? ` + ${persistentBonus}` : ''} = ${currentTotal}. ${success ? 'Success!' : 'Failed.'} (needed ${requiredRoll}).`;
    socket.emit('heroRollResult', { heroInstanceId: hero.instanceId, die1, die2, total: currentTotal, requiredRoll, success, message });

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
    heroInstanceId: hero.instanceId, rollingPlayerId: socket.id,
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

const getEligibleChallengerIds = (gameState: GameState, activePlayerId: string): string[] =>
  Object.entries(gameState.players)
    .filter(([pid]) => pid !== activePlayerId)
    .filter(([, player]) =>
      player.zones.hand.some(card => {
        if (card.cardType !== 'challenge') return false;
        const template = gameState.cardTemplates[card.templateId];
        const req = template?.onEvent?.requirement;
        if (!req) return true;
        if (req.cardType === 'hero' && req.class && req.eligibility === 'self') {
          return player.zones.party.some(
            partyCard => getHeroEffectiveClass(gameState, player, partyCard) === req.class
          );
        }
        return true;
      })
    )
    .map(([pid]) => pid);

const getChallengeCardBonus = (template: CardTemplate | undefined): number => {
  if (!template) return 0;
  const effects = template.onEvent?.effects;
  if (!effects) return 0;
  const modifyRoll = effects.find(e => e.action === 'MODIFY_ROLL');
  return modifyRoll?.amount ?? 0;
};

const getPartyLeaderChallengeBonus = (gameState: GameState, playerId: string): number => {
  const player = gameState.players[playerId];
  if (!player?.partyLeaderId) return 0;
  const leaderTemplate = gameState.cardTemplates[player.partyLeaderId];
  if (
    leaderTemplate?.effect?.triggerEvent === 'ON_CHALLENGE' &&
    leaderTemplate.effect.action === 'PERSISTENT_MODIFIER' &&
    leaderTemplate.effect.applies_to === 'CHALLENGE_ROLLS'
  ) {
    return leaderTemplate.effect.modifier ?? 0;
  }
  return 0;
};

const openChallengeWindow = (roomCode: string, gameState: GameState, pending: PendingChallengeState) => {
  const cardTemplate = gameState.cardTemplates[pending.pendingCardInstance.templateId];
  const pendingCardName = cardTemplate?.name ?? pending.pendingCardInstance.templateId;
  gameState.pendingChallenge = {
    pendingPlayerId: pending.pendingPlayerId,
    pendingCardName,
    pendingCardType: pending.pendingCardType,
    eligibleChallengerIds: [...pending.eligibleChallengerIds],
  };
  pendingChallenges.set(roomCode, pending);
};

const executePendingCardPlay = (roomCode: string, pending: PendingChallengeState, gameState: GameState) => {
  const player = gameState.players[pending.pendingPlayerId];
  if (!player) return;

  if (pending.pendingCardType === 'hero') {
    player.zones.party.push(pending.pendingCardInstance);
    applyWinIfMet(gameState, player, pending.pendingPlayerId);
    if (!heroesPlayedFromAbilityThisTurn.has(roomCode)) {
      heroesPlayedFromAbilityThisTurn.set(roomCode, new Set());
    }
    heroesPlayedFromAbilityThisTurn.get(roomCode)!.add(pending.pendingCardInstance.instanceId);
    const playerSocket = getSocketByPlayerId(pending.pendingPlayerId);
    if (playerSocket) playerSocket.emit('heroPlayAccepted', pending.pendingCardInstance.instanceId);
  } else if (pending.pendingCardType === 'item') {
    const targetPlayer = gameState.players[pending.itemTargetPlayerId ?? pending.pendingPlayerId];
    if (targetPlayer) {
      targetPlayer.zones.party.push(pending.pendingCardInstance);
      const targetHero = targetPlayer.zones.party.find(c => c.instanceId === pending.itemTargetHeroInstanceId);
      if (targetHero) targetHero.equippedItem = pending.pendingCardInstance.instanceId;
    }
  } else if (pending.pendingCardType === 'magic') {
    gameState.discardPile.push(pending.pendingCardInstance);
    const playerSocket = getSocketByPlayerId(pending.pendingPlayerId);
    if (playerSocket && pending.magicSteps) {
      processMagicCardSteps(
        playerSocket,
        gameState,
        player,
        pending.pendingCardInstance.instanceId,
        pending.magicSteps,
        undefined
      );
    }
  }
};

const resolveChallengeRollOff = (
  roomCode: string,
  pending: PendingChallengeState,
  gameState: GameState,
  sendRoomUpdate: () => void
) => {
  if (!pending.challengerId) return;
  const challenger = gameState.players[pending.challengerId];
  const challenged = gameState.players[pending.pendingPlayerId];
  if (!challenger || !challenged) return;

  const challengerRoll = Math.floor(Math.random() * 6) + 1 + Math.floor(Math.random() * 6) + 1;
  const challengerBonus = pending.challengerRollBonus + getPartyLeaderChallengeBonus(gameState, pending.challengerId);
  const challengerTotalRoll = challengerRoll + challengerBonus;
  const challengedRoll = Math.floor(Math.random() * 6) + 1 + Math.floor(Math.random() * 6) + 1;

  const challengerWon = challengerTotalRoll > challengedRoll;

  if (pending.challengeCardInstanceId) {
    moveCardBetweenZones(challenger.zones.hand, gameState.discardPile, pending.challengeCardInstanceId);
  }

  const cardTemplate = gameState.cardTemplates[pending.pendingCardInstance.templateId];
  const cardName = cardTemplate?.name ?? pending.pendingCardInstance.templateId;

  if (challengerWon) {
    gameState.discardPile.push(pending.pendingCardInstance);
  } else {
    executePendingCardPlay(roomCode, pending, gameState);
  }

  delete gameState.pendingChallenge;
  pendingChallenges.delete(roomCode);

  io.to(roomCode).emit('challengeResolved', {
    challengerWon,
    challengerName: challenger.username ?? pending.challengerId,
    challengedName: challenged.username ?? pending.pendingPlayerId,
    challengerRoll,
    challengerBonus,
    challengerTotalRoll,
    challengedRoll,
    cardName,
  });

  sendRoomUpdate();
};

const triggerEndTurn = (
  playerId: string,
  gameState: GameState,
  roomCode: string,
  sendRoomUpdate: () => void
) => {
  const currentPlayer = gameState.players[playerId];
  if (currentPlayer) decrementTemporaryModifiers(currentPlayer);
  delete gameState.roomFlags;
  delete gameState.forceEndTurn;

  const playerIds = Object.keys(gameState.players);
  if (playerIds.length === 0) return;

  const currentIndex = playerIds.findIndex((id) => id === playerId);
  const nextIndex = (currentIndex + 1) % playerIds.length;
  const nextPlayerId = playerIds[nextIndex] ?? '';

  gameState.activePlayerId = nextPlayerId;
  gameState.turnNumber = (gameState.turnNumber ?? 0) + 1;

  const nextPlayer = nextPlayerId ? gameState.players[nextPlayerId] : undefined;
  if (nextPlayer) {
    nextPlayer.actionPoints = 3;
    for (const slainMonster of nextPlayer.slainMonsters ?? []) {
      const mt = gameState.cardTemplates[slainMonster.templateId];
      if (mt?.slainEffect?.action === 'EXTRA_AP') {
        nextPlayer.actionPoints += mt.slainEffect.amount ?? 0;
      }
    }
    nextPlayer.zones.party.forEach((card) => { card.effectUsedThisTurn = false; });
    nextPlayer.zones.hand.forEach((card) => { card.effectUsedThisTurn = false; });
  }

  heroesPlayedFromAbilityThisTurn.delete(roomCode);
  pendingChallenges.delete(roomCode);
  delete gameState.pendingChallenge;
  modifierPhases.delete(roomCode);
  delete gameState.modifierPhase;
  sendRoomUpdate();
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

  const template = gameState.cardTemplates[hero.templateId];
  if (!template?.activeSkill || !Array.isArray(template.activeSkill.effects)) {
    sourceSocket.emit('actionFailed', 'This hero has no ability to activate.');
    return;
  }

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
      sourcePlayerId: sourceSocket.id,
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
      requesterId: sourceSocket.id,
    });
    return;
  }

  const sacrificeCost = costs.find(c => c.type === 'SACRIFICE');
  if (sacrificeCost) {
    const sacrificeOptions = player.zones.party
      .filter((card) => card.cardType !== 'party_leader')
      .map((card) => ({
        id: card.instanceId,
        label: gameState.cardTemplates[card.templateId]?.name || card.templateId,
        payload: { cardInstanceId: card.instanceId },
      }));
    if (sacrificeOptions.length === 0) {
      sourceSocket.emit('actionFailed', 'No cards available to sacrifice.');
      return;
    }
    const promptId = buildPromptId();
    abilityPromptRequests.set(promptId, {
      promptId,
      roomCode: sourceSocket.data.roomCode as string,
      heroInstanceId,
      sourcePlayerId: sourceSocket.id,
      promptType: 'discardCard',
      message: 'Choose a card to sacrifice.',
      options: sacrificeOptions,
      effect: { action: 'SACRIFICE', ...sacrificeCost } as Effect,
      remainingEffects: template.activeSkill.effects,
    });
    sourceSocket.emit('abilityPrompt', {
      promptId,
      heroInstanceId,
      promptType: 'discardCard',
      message: 'Choose a card to sacrifice.',
      options: sacrificeOptions,
      requesterId: sourceSocket.id,
    });
    return;
  }

  const result = processHeroAbilityEffects(sourceSocket, gameState, player, hero, template, template.activeSkill.effects);

  // Check if a prompt was just emitted (waiting for user input)
  // If so, don't call emitAbilityResolution yet; let handlePromptResponse handle it
  const pendingPrompts = Array.from(abilityPromptRequests.values()).filter(
    (req) => req.heroInstanceId === heroInstanceId && req.sourcePlayerId === sourceSocket.id
  );

  if (pendingPrompts.length === 0) {
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

const processMagicCardSteps = (
  socket: Socket<ClientToServerEvents, ServerToClientEvents>,
  gameState: GameState,
  player: Player,
  magicCardId: string,
  steps: Effect[],
  responsePayload?: { playerId?: string; cardInstanceId?: string; [key: string]: unknown }
): string[] => {
  const messages: string[] = [];
  let promptCreated = false;

  // p_007 Cloaked Sage: draw 1 each time you play a magic card
  if (player.partyLeaderId) {
    const plTemplate = gameState.cardTemplates[player.partyLeaderId];
    if (plTemplate?.effect?.triggerEvent === 'ON_DRAW_MAGIC' && plTemplate.effect.action === 'DRAW') {
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
        emitAbilityPrompt(socket.id, {
          promptId: buildPromptId(),
          roomCode: socket.data.roomCode as string,
          heroInstanceId: magicCardId,
          sourcePlayerId: socket.id,
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
          for (const [opId, opponent] of Object.entries(gameState.players)) {
            if (opId === socket.id) continue;
            const heroIdx = opponent.zones.party.findIndex(c => c.instanceId === responsePayload.cardInstanceId);
            if (heroIdx !== -1) {
              const [hero] = opponent.zones.party.splice(heroIdx, 1);
              if (hero) {
                gameState.discardPile.push(hero);
                if (hero.equippedItem) {
                  const itemIdx = opponent.zones.party.findIndex(c => c.instanceId === hero.equippedItem);
                  if (itemIdx !== -1) {
                    const [item] = opponent.zones.party.splice(itemIdx, 1);
                    if (item) gameState.discardPile.push(item);
                  }
                }
                stepResult = `Destroyed ${gameState.cardTemplates[hero.templateId]?.name || 'hero'}.`;
              }
              break;
            }
          }
          if (!stepResult) stepResult = 'Hero not found.';
          break;
        }
        const destroyOptions: AbilityPromptOption[] = [];
        for (const [opId, opp] of Object.entries(gameState.players)) {
          if (opId === socket.id) continue;
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
        emitAbilityPrompt(socket.id, {
          promptId: buildPromptId(),
          roomCode: socket.data.roomCode as string,
          heroInstanceId: magicCardId,
          sourcePlayerId: socket.id,
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
      case 'STEAL': {
        if (responsePayload?.cardInstanceId && responsePayload?.playerId) {
          const opponentId = responsePayload.playerId as string;
          const opponent = gameState.players[opponentId];
          if (!opponent) { stepResult = 'Opponent not found.'; break; }
          const card = moveCardBetweenZones(opponent.zones.party, player.zones.party, responsePayload.cardInstanceId);
          if (!card) { stepResult = 'Could not steal hero.'; break; }
          if (card.equippedItem) moveCardBetweenZones(opponent.zones.party, player.zones.party, card.equippedItem);
          stepResult = `Stole ${gameState.cardTemplates[card.templateId]?.name || 'hero'} from ${opponent.username || 'opponent'}.`;
          break;
        }
        const stealOptions: AbilityPromptOption[] = [];
        for (const [opId, opp] of Object.entries(gameState.players)) {
          if (opId === socket.id) continue;
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
        emitAbilityPrompt(socket.id, {
          promptId: buildPromptId(),
          roomCode: socket.data.roomCode as string,
          heroInstanceId: magicCardId,
          sourcePlayerId: socket.id,
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
        emitAbilityPrompt(socket.id, {
          promptId: buildPromptId(),
          roomCode: socket.data.roomCode as string,
          heroInstanceId: magicCardId,
          sourcePlayerId: socket.id,
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
        if (cardId) {
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
        sendRoomUpdate();
        return;
      }
      default:
        sendRoomUpdate();
        return;
    }
  }

  if (request.isPartyLeaderAbility) {
    const targetPlayerId = responsePayload?.playerId;
    if (targetPlayerId) {
      const targetPlayer = gameState.players[targetPlayerId];
      if (targetPlayer && targetPlayer.zones.hand.length > 0) {
        const randomIdx = Math.floor(Math.random() * targetPlayer.zones.hand.length);
        const [stolenCard] = targetPlayer.zones.hand.splice(randomIdx, 1);
        if (stolenCard) sourcePlayer.zones.hand.push(stolenCard);
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
      // m_005 Rex Major: draw one extra card (the extra draw does not re-trigger).
      if (option.id === 'yes' && gameState.mainDeck.length > 0) {
        sourcePlayer.zones.hand.push(...drawCards(gameState.mainDeck, 1));
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

  const result = processHeroAbilityEffects(sourceSocket, gameState, player, sourceHero, template, [request.effect], responsePayload);

  let remainingResult: string | undefined;
  if (request.remainingEffects.length > 0) {
    // Pass playerId from the response payload so chained effects like STEAL_RANDOM_CARD
    // target_owner can access who owns the card that was just selected.
    const remainingPayload = responsePayload?.playerId ? { playerId: responsePayload.playerId } : undefined;
    remainingResult = processHeroAbilityEffects(sourceSocket, gameState, sourcePlayer, sourceHero, template, request.remainingEffects, remainingPayload) ?? undefined;
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

// Falls back to the Vite dev server origin for local development. In production,
// set CORS_ORIGIN to the deployed frontend origin. Must be an explicit origin
// (not "*") because the client connects with credentials.
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';

const app = express();
app.use(cors({origin: CORS_ORIGIN, credentials: true}));
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
const API_URL = CORS_ORIGIN;

// Apply the types to the Socket Server
const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  cors: {
    origin: API_URL,
    methods: ["GET", "POST"],
    credentials: true
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

  const isExistingPlayer = !!gameState.players[socket.id];
  if (!isExistingPlayer && Object.keys(gameState.players).length >= 6) {
    socket.emit('roomFull', 'This room is full (6 players max).');
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
      slainMonsters: [],
      zones: {
        hand: [],
        party: [],
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

    const card = drawCardsForPlayer(gameState, player, 1)[0];
    if (!card) return;

    player.actionPoints = (player.actionPoints ?? 0) - 1;

    socket.emit('cardDrawn', { instanceId: card.instanceId, templateId: card.templateId });

    sendRoomUpdate();
  });

  socket.on('mulligan', () => {
    const gameState = getRoomState(socket.data.roomCode as string);
    if (!gameState || gameState.status !== 'in_progress') return;
    if (socket.id !== gameState.activePlayerId) {
      socket.emit('actionFailed', 'Not your turn.');
      return;
    }
    const player = gameState.players[socket.id];
    if (!player) return;
    if ((player.actionPoints ?? 0) < 3) {
      socket.emit('actionFailed', 'Not enough AP to mulligan (costs 3 AP).');
      return;
    }
    if (gameState.mainDeck.length < 5) {
      socket.emit('actionFailed', 'Not enough cards in the deck to mulligan.');
      return;
    }

    gameState.discardPile.push(...player.zones.hand);
    player.zones.hand = [];
    drawCardsForPlayer(gameState, player, 5);
    player.actionPoints = (player.actionPoints ?? 0) - 3;

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

    player.actionPoints = (player.actionPoints ?? 0) - 1;

    const roomCode = socket.data.roomCode as string;
    const eligibleChallengerIds = getEligibleChallengerIds(gameState, socket.id);

    if (eligibleChallengerIds.length > 0) {
      openChallengeWindow(roomCode, gameState, {
        pendingCardInstance: playedCard,
        pendingPlayerId: socket.id,
        pendingCardType: 'hero',
        eligibleChallengerIds,
        passedPlayerIds: new Set(),
        challengerRollBonus: 0,
      });
    } else {
      player.zones.party.push(playedCard);
      applyWinIfMet(gameState, player, socket.id);
      if (!heroesPlayedFromAbilityThisTurn.has(roomCode)) {
        heroesPlayedFromAbilityThisTurn.set(roomCode, new Set());
      }
      heroesPlayedFromAbilityThisTurn.get(roomCode)!.add(playedCard.instanceId);
      socket.emit('heroPlayAccepted', playedCard.instanceId);
    }

    sendRoomUpdate();
  });

  socket.on('playMagic', (cardInstanceId) => {
    const gameState = getRoomState(socket.data.roomCode as string);
    if (!gameState || gameState.status !== 'in_progress') {
      socket.emit('actionFailed', 'Cannot play a magic card now.');
      return;
    }
    if (socket.id !== gameState.activePlayerId) {
      socket.emit('actionFailed', 'Not your turn.');
      return;
    }
    const player = gameState.players[socket.id];
    if (!player) return;
    if ((player.actionPoints ?? 0) < 1) {
      socket.emit('actionFailed', 'Not enough AP to play a magic card.');
      return;
    }
    const cardIndex = player.zones.hand.findIndex(c => c.instanceId === cardInstanceId);
    if (cardIndex === -1) {
      socket.emit('actionFailed', 'Magic card not found in hand.');
      return;
    }
    const card = player.zones.hand[cardIndex];
    if (!card || card.cardType !== 'magic') {
      socket.emit('actionFailed', 'Selected card is not a magic card.');
      return;
    }
    const template = gameState.cardTemplates[card.templateId];
    if (!template?.effect) {
      socket.emit('actionFailed', 'This magic card has no effect defined.');
      return;
    }
    player.actionPoints = (player.actionPoints ?? 0) - 1;
    const [removedMagicCard] = player.zones.hand.splice(cardIndex, 1);
    if (!removedMagicCard) { sendRoomUpdate(); return; }

    const magicRoomCode = socket.data.roomCode as string;
    const steps: Effect[] = template.effect.steps ?? [template.effect as unknown as Effect];
    const magicEligibleIds = getEligibleChallengerIds(gameState, socket.id);

    if (magicEligibleIds.length > 0) {
      openChallengeWindow(magicRoomCode, gameState, {
        pendingCardInstance: removedMagicCard,
        pendingPlayerId: socket.id,
        pendingCardType: 'magic',
        magicSteps: steps,
        eligibleChallengerIds: magicEligibleIds,
        passedPlayerIds: new Set(),
        challengerRollBonus: 0,
      });
    } else {
      gameState.discardPile.push(removedMagicCard);
      processMagicCardSteps(socket, gameState, player, removedMagicCard.instanceId, steps, undefined);
    }

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

    const [removedItem] = player.zones.hand.splice(itemIndex, 1);
    if (!removedItem) {
      socket.emit('actionFailed', 'Failed to remove item from hand.');
      return;
    }

    player.actionPoints = (player.actionPoints ?? 0) - 1;

    const itemRoomCode = socket.data.roomCode as string;
    const itemEligibleIds = playerHasSlainEffectFlag(gameState, player, 'blockItemChallenges')
      ? []
      : getEligibleChallengerIds(gameState, socket.id);

    if (itemEligibleIds.length > 0) {
      openChallengeWindow(itemRoomCode, gameState, {
        pendingCardInstance: removedItem,
        pendingPlayerId: socket.id,
        pendingCardType: 'item',
        itemTargetPlayerId: socket.id,
        itemTargetHeroInstanceId: targetHeroInstanceId,
        eligibleChallengerIds: itemEligibleIds,
        passedPlayerIds: new Set(),
        challengerRollBonus: 0,
      });
    } else {
      player.zones.party.push(removedItem);
      targetHero.equippedItem = removedItem.instanceId;
    }

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

    const [removedCursedItem] = player.zones.hand.splice(itemIndex, 1);
    if (!removedCursedItem) {
      socket.emit('actionFailed', 'Failed to remove cursed item from hand.');
      return;
    }

    player.actionPoints = (player.actionPoints ?? 0) - 1;

    const cursedRoomCode = socket.data.roomCode as string;
    const cursedEligibleIds = playerHasSlainEffectFlag(gameState, player, 'blockItemChallenges')
      ? []
      : getEligibleChallengerIds(gameState, socket.id);

    if (cursedEligibleIds.length > 0) {
      openChallengeWindow(cursedRoomCode, gameState, {
        pendingCardInstance: removedCursedItem,
        pendingPlayerId: socket.id,
        pendingCardType: 'item',
        itemTargetPlayerId: targetPlayerId,
        itemTargetHeroInstanceId: targetHeroInstanceId,
        eligibleChallengerIds: cursedEligibleIds,
        passedPlayerIds: new Set(),
        challengerRollBonus: 0,
      });
    } else {
      targetPlayer.zones.party.push(removedCursedItem);
      targetHero.equippedItem = removedCursedItem.instanceId;
    }

    sendRoomUpdate();
  });

  socket.on('playChallenge', (challengeCardInstanceId) => {
    const gameState = getRoomState(socket.data.roomCode as string);
    const roomCode = socket.data.roomCode as string;
    if (!gameState) return;

    const pending = pendingChallenges.get(roomCode);
    if (!pending) {
      socket.emit('actionFailed', 'No active challenge window.');
      return;
    }
    if (pending.challengerId) {
      socket.emit('actionFailed', 'This card play has already been challenged.');
      return;
    }
    if (!pending.eligibleChallengerIds.includes(socket.id) || pending.passedPlayerIds.has(socket.id)) {
      socket.emit('actionFailed', 'You are not eligible to challenge.');
      return;
    }

    const player = gameState.players[socket.id];
    if (!player) return;

    const challengeCard = player.zones.hand.find(
      c => c.instanceId === challengeCardInstanceId && c.cardType === 'challenge'
    );
    if (!challengeCard) {
      socket.emit('actionFailed', 'Challenge card not found in hand.');
      return;
    }

    const template = gameState.cardTemplates[challengeCard.templateId];
    const req = template?.onEvent?.requirement;
    if (req?.cardType === 'hero' && req.class && req.eligibility === 'self') {
      const hasClass = player.zones.party.some(
        partyCard => getHeroEffectiveClass(gameState, player, partyCard) === req.class
      );
      if (!hasClass) {
        socket.emit('actionFailed', `You need a ${req.class} hero in your party to play this challenge card.`);
        return;
      }
    }

    pending.challengerId = socket.id;
    pending.challengeCardInstanceId = challengeCardInstanceId;
    pending.challengerRollBonus = getChallengeCardBonus(template);

    const gsPending = gameState.pendingChallenge;
    if (gsPending) gsPending.challengerId = socket.id;

    resolveChallengeRollOff(roomCode, pending, gameState, sendRoomUpdate);
  });

  socket.on('passChallenge', () => {
    const gameState = getRoomState(socket.data.roomCode as string);
    const roomCode = socket.data.roomCode as string;
    if (!gameState) return;

    const pending = pendingChallenges.get(roomCode);
    if (!pending || pending.challengerId) return;
    if (!pending.eligibleChallengerIds.includes(socket.id) || pending.passedPlayerIds.has(socket.id)) return;

    pending.passedPlayerIds.add(socket.id);
    const remaining = pending.eligibleChallengerIds.filter(id => !pending.passedPlayerIds.has(id));

    if (remaining.length === 0) {
      executePendingCardPlay(roomCode, pending, gameState);
      pendingChallenges.delete(roomCode);
      delete gameState.pendingChallenge;
    } else {
      const gsPending = gameState.pendingChallenge;
      if (gsPending) gsPending.eligibleChallengerIds = remaining;
    }

    sendRoomUpdate();
  });

  socket.on('playModifier', (modifierInstanceId, choiceIndex) => {
    const roomCode = socket.data.roomCode as string;
    const gameState = getRoomState(roomCode);
    if (!gameState) return;

    if (pendingChallenges.has(roomCode)) {
      socket.emit('actionFailed', 'Cannot play a modifier during a challenge window.');
      return;
    }

    const phase = modifierPhases.get(roomCode);
    if (!phase) {
      socket.emit('actionFailed', 'No active modifier phase.');
      return;
    }

    const isRollerTurn = phase.phase === 'roller_turn' && socket.id === phase.rollingPlayerId;
    const isOpponentTurn = phase.phase === 'opponent_turn' && phase.opponentQueue[0] === socket.id;
    if (!isRollerTurn && !isOpponentTurn) {
      socket.emit('actionFailed', 'It is not your turn to play a modifier.');
      return;
    }

    const player = gameState.players[socket.id];
    if (!player) return;

    const cardIndex = player.zones.hand.findIndex(c => c.instanceId === modifierInstanceId && c.cardType === 'modifier');
    if (cardIndex === -1) {
      socket.emit('actionFailed', 'Modifier card not found in hand.');
      return;
    }

    const [card] = player.zones.hand.splice(cardIndex, 1);
    if (!card) return;
    gameState.discardPile.push(card);

    const template = gameState.cardTemplates[card.templateId];
    const amount = getModifierAmount(template, choiceIndex, phase.rollContext);
    const choiceLabel = getModifierChoiceLabel(template, choiceIndex, phase.rollContext);
    phase.accumulatedModifier += amount;
    // p_004 Protecting Horn: +1 (or -1 matching direction) when THIS player plays a modifier
    if (amount !== 0 && player.partyLeaderId) {
      const plTemplate = gameState.cardTemplates[player.partyLeaderId];
      if (plTemplate?.effect?.triggerEvent === 'ON_MODIFIER_PLAYED') {
        phase.accumulatedModifier += amount > 0 ? 1 : -1;
      }
    }
    phase.modifiersPlayed.push({
      playerName: player.username ?? socket.id,
      cardName: template?.name ?? card.templateId,
      amount,
      choiceLabel,
    });

    if (phase.phase === 'opponent_turn') phase.cardPlayedThisCycle = true;

    if (phase.phase === 'roller_turn') {
      const newTotal = phase.rawDiceTotal + phase.persistentBonus + phase.accumulatedModifier;
      if (newTotal >= phase.requiredRoll) {
        phase.phase = 'opponent_turn';
        phase.opponentQueue = phase.allOpponentsWithModifiers.filter(
          pid => gameState.players[pid]?.zones.hand.some(c => c.cardType === 'modifier')
        );
        phase.cardPlayedThisCycle = false;
        if (phase.opponentQueue.length === 0) {
          finalizeRoll(roomCode, phase, gameState, sendRoomUpdate);
          return;
        }
      }
    }

    updateModifierPhaseGameState(roomCode, phase, gameState);
    sendRoomUpdate();
  });

  socket.on('passModifier', () => {
    const roomCode = socket.data.roomCode as string;
    const gameState = getRoomState(roomCode);
    if (!gameState) return;

    const phase = modifierPhases.get(roomCode);
    if (!phase) {
      socket.emit('actionFailed', 'No active modifier phase.');
      return;
    }

    const isRollerTurn = phase.phase === 'roller_turn' && socket.id === phase.rollingPlayerId;
    const isOpponentTurn = phase.phase === 'opponent_turn' && phase.opponentQueue[0] === socket.id;
    if (!isRollerTurn && !isOpponentTurn) {
      socket.emit('actionFailed', 'It is not your turn to pass.');
      return;
    }

    if (phase.phase === 'roller_turn') {
      phase.phase = 'opponent_turn';
      phase.opponentQueue = phase.allOpponentsWithModifiers.filter(
        pid => gameState.players[pid]?.zones.hand.some(c => c.cardType === 'modifier')
      );
      phase.cardPlayedThisCycle = false;
      if (phase.opponentQueue.length === 0) {
        finalizeRoll(roomCode, phase, gameState, sendRoomUpdate);
        return;
      }
      updateModifierPhaseGameState(roomCode, phase, gameState);
      sendRoomUpdate();
      return;
    }

    advanceModifierQueue(roomCode, phase, gameState, sendRoomUpdate);
  });

  socket.on('usePartyLeaderAbility', () => {
    const roomCode = socket.data.roomCode as string;
    const gameState = getRoomState(roomCode);
    if (!gameState || gameState.status !== 'in_progress') return;
    if (socket.id !== gameState.activePlayerId) {
      socket.emit('actionFailed', 'Not your turn.');
      return;
    }
    if (pendingChallenges.has(roomCode) || modifierPhases.has(roomCode)) {
      socket.emit('actionFailed', 'Cannot use party leader ability during an active roll or challenge.');
      return;
    }

    const player = gameState.players[socket.id];
    if (!player) return;

    const partyLeaderCard = player.zones.party.find(c => c.cardType === 'party_leader');
    if (!partyLeaderCard) {
      socket.emit('actionFailed', 'No party leader in play.');
      return;
    }
    if (partyLeaderCard.effectUsedThisTurn) {
      socket.emit('actionFailed', 'Party leader ability already used this turn.');
      return;
    }

    const template = gameState.cardTemplates[partyLeaderCard.templateId];
    if (!template?.effect?.isOptional) {
      socket.emit('actionFailed', 'This party leader ability triggers automatically.');
      return;
    }

    if (template?.effect?.action === 'STEAL_CARD') {
      const opponents = Object.entries(gameState.players).filter(
        ([id, p]) => id !== socket.id && p.zones.hand.length > 0
      );
      if (opponents.length === 0) {
        socket.emit('actionFailed', 'No opponents have cards to steal.');
        return;
      }
      const options: AbilityPromptOption[] = opponents.map(([id, p]) => ({
        id: `player_${id}`,
        label: `${p.username ?? id} (${p.zones.hand.length} card${p.zones.hand.length !== 1 ? 's' : ''})`,
        payload: { playerId: id },
      }));
      emitAbilityPrompt(socket.id, {
        promptId: buildPromptId(),
        roomCode,
        heroInstanceId: partyLeaderCard.instanceId,
        sourcePlayerId: socket.id,
        promptType: 'selectPlayer',
        message: 'Choose an opponent to steal a card from.',
        options,
        effect: { action: 'STEAL_CARD' },
        remainingEffects: [],
        isPartyLeaderAbility: true,
      });
    }
    sendRoomUpdate();
  });

  socket.on('attackMonster', (monsterInstanceId) => {
    const roomCode = socket.data.roomCode as string;
    const gameState = getRoomState(roomCode);
    if (!gameState || gameState.status !== 'in_progress') return;

    if (socket.id !== gameState.activePlayerId) {
      socket.emit('actionFailed', 'Not your turn.');
      return;
    }

    if (pendingChallenges.has(roomCode) || modifierPhases.has(roomCode)) {
      socket.emit('actionFailed', 'Cannot attack while another action is pending.');
      return;
    }

    const player = gameState.players[socket.id];
    if (!player) return;

    if ((player.actionPoints ?? 0) < 2) {
      socket.emit('actionFailed', 'Not enough AP to attack a monster (costs 2 AP).');
      return;
    }

    const monster = gameState.activeMonsters.find(m => m.instanceId === monsterInstanceId);
    if (!monster) {
      socket.emit('actionFailed', 'Monster not found.');
      return;
    }

    const monsterTemplate = gameState.cardTemplates[monster.templateId];
    const reqCheck = checkMonsterRequirements(gameState, player, monsterTemplate);
    if (!reqCheck.met) {
      socket.emit('actionFailed', `Requirements not met: ${reqCheck.missing}`);
      return;
    }
    if (!monsterTemplate) {
      socket.emit('actionFailed', 'Monster template not found.');
      return;
    }

    player.actionPoints = (player.actionPoints ?? 0) - 2;
    executeMonsterAttackRoll(roomCode, socket, gameState, player, monster, monsterTemplate, sendRoomUpdate);
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

    if (hero.effectUsedThisTurn) {
      socket.emit('actionFailed', 'This hero ability has already been used this turn.');
      return;
    }

    const playedFromAbility = heroesPlayedFromAbilityThisTurn.get(socket.data.roomCode as string)?.has(heroInstanceId) ?? false;
    if (!playedFromAbility) {
      if ((player.actionPoints ?? 0) < 1) {
        socket.emit('actionFailed', 'Not enough AP to use a hero ability.');
        return;
      }
      player.actionPoints = (player.actionPoints ?? 0) - 1;
    }

    let preRollBonus = 0;
    const equippedItemId = hero.equippedItem;
    if (equippedItemId) {
      const itemInstance = player.zones.party.find(c => c.instanceId === equippedItemId);
      if (itemInstance) {
        const itemTemplate = gameState.cardTemplates[itemInstance.templateId];

        const passives = itemTemplate?.passiveModifiers;
        if (passives?.some(p => p.stat === 'heroEffectLocked')) {
          if (!playedFromAbility) player.actionPoints = (player.actionPoints ?? 0) + 1;
          socket.emit('actionFailed', 'This hero\'s effect is locked by an equipped item.');
          sendRoomUpdate();
          return;
        }

        const itemTrigger = itemTemplate?.trigger;
        if (itemTrigger?.event === 'ON_HERO_ROLL_ATTEMPT' && itemTrigger.scope === 'equipped_hero') {
          const modifyEffect = itemTrigger.effects.find(e => e.action === 'MODIFY_ROLL');
          if (modifyEffect) {
            if (!itemTrigger.optional) {
              preRollBonus += modifyEffect.amount ?? 0;
            } else {
              const maxDiscard = (itemTrigger.cost?.[0]?.max as number | undefined) ?? 3;
              const minDiscard = (itemTrigger.cost?.[0]?.min as number | undefined) ?? 0;
              const bonusPerCard = modifyEffect.amount ?? 0;
              const availableMax = Math.min(maxDiscard, player.zones.hand.length);
              if (availableMax < 1) {
                // Nothing to discard — just roll with no bonus.
                executeRollAndEmit(socket, gameState, player, hero, 0, sendRoomUpdate);
                return;
              }
              const cardOptions: AbilityPromptOption[] = player.zones.hand.map(c => ({
                id: c.instanceId,
                label: gameState.cardTemplates[c.templateId]?.name || c.templateId,
                payload: { cardInstanceId: c.instanceId },
              }));
              emitAbilityPrompt(socket.id, {
                promptId: buildPromptId(),
                roomCode: socket.data.roomCode as string,
                heroInstanceId: hero.instanceId,
                sourcePlayerId: socket.id,
                promptType: 'multiSelectCard',
                message: `${itemTemplate?.name ?? itemInstance.templateId}: select up to ${availableMax} card${availableMax > 1 ? 's' : ''} to discard for +${bonusPerCard} each, then confirm.`,
                options: cardOptions,
                minSelections: minDiscard,
                maxSelections: availableMax,
                effect: { action: 'ITEM_I004_DISCARD_SELECT', bonusPerCard },
                remainingEffects: [],
                isItemTrigger: true,
                itemInstanceId: itemInstance.instanceId,
              });
              sendRoomUpdate();
              return;
            }
          }
        }
      }
    }

    executeRollAndEmit(socket, gameState, player, hero, preRollBonus, sendRoomUpdate);
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

    activateHeroAbility(socket, gameState, heroInstanceId, sendRoomUpdate);
  });

  socket.on('respondToAbilityPrompt', (promptId, selectedOptionId) => {
    handlePromptResponse(socket, promptId, selectedOptionId, sendRoomUpdate);
  });

  socket.on('respondToAbilityPromptMulti', (promptId, selectedOptionIds) => {
    handleMultiPromptResponse(socket, promptId, selectedOptionIds, sendRoomUpdate);
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
    if (pendingChallenges.has(socket.data.roomCode as string)) {
      socket.emit('actionFailed', 'Cannot end turn while a challenge is pending.');
      return;
    }
    if (modifierPhases.has(socket.data.roomCode as string)) {
      socket.emit('actionFailed', 'Cannot end turn during a modifier phase.');
      return;
    }

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
      for (const slainMonster of nextPlayer.slainMonsters ?? []) {
        const mt = gameState.cardTemplates[slainMonster.templateId];
        if (mt?.slainEffect?.action === 'EXTRA_AP') nextPlayer.actionPoints += mt.slainEffect.amount ?? 0;
      }
      // Reset ability usage flags for new active player
      nextPlayer.zones.party.forEach((card) => {
        card.effectUsedThisTurn = false;
      });
      nextPlayer.zones.hand.forEach((card) => {
        card.effectUsedThisTurn = false;
      });
    }

    heroesPlayedFromAbilityThisTurn.delete(socket.data.roomCode as string);
    delete gameState.roomFlags;

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
    player.partyLeaderId = chosenCard.templateId;

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
    pendingChallenges.delete(socket.data.roomCode as string);
    delete gameState.pendingChallenge;
    modifierPhases.delete(socket.data.roomCode as string);
    delete gameState.modifierPhase;
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
      player.actionPoints = 3;
      player.partyLeaderId = undefined;
      player.slainMonsters = [];
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
          slainMonsters: [],
          zones: {
            hand: [],
            party: [],
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

    const disconnectPending = pendingChallenges.get(roomCode);
    if (disconnectPending) {
      if (disconnectPending.pendingPlayerId === socket.id) {
        gameState.discardPile.push(disconnectPending.pendingCardInstance);
        pendingChallenges.delete(roomCode);
        delete gameState.pendingChallenge;
      } else if (disconnectPending.eligibleChallengerIds.includes(socket.id)) {
        disconnectPending.passedPlayerIds.add(socket.id);
        const remaining = disconnectPending.eligibleChallengerIds.filter(id => !disconnectPending.passedPlayerIds.has(id));
        if (remaining.length === 0 && !disconnectPending.challengerId) {
          executePendingCardPlay(roomCode, disconnectPending, gameState);
          pendingChallenges.delete(roomCode);
          delete gameState.pendingChallenge;
        } else {
          const gsPending = gameState.pendingChallenge;
          if (gsPending) gsPending.eligibleChallengerIds = remaining;
        }
      }
    }

    const modPhase = modifierPhases.get(roomCode);
    if (modPhase) {
      if (modPhase.rollingPlayerId === socket.id) {
        modifierPhases.delete(roomCode);
        delete gameState.modifierPhase;
      } else if (modPhase.allOpponentsWithModifiers.includes(socket.id)) {
        modPhase.allOpponentsWithModifiers = modPhase.allOpponentsWithModifiers.filter(id => id !== socket.id);
        modPhase.opponentQueue = modPhase.opponentQueue.filter(id => id !== socket.id);
        if (modPhase.phase === 'opponent_turn' && modPhase.opponentQueue.length === 0) {
          if (modPhase.cardPlayedThisCycle) {
            const newQueue = modPhase.allOpponentsWithModifiers.filter(
              pid => gameState.players[pid]?.zones.hand.some(c => c.cardType === 'modifier')
            );
            if (newQueue.length === 0) {
              finalizeRoll(roomCode, modPhase, gameState, sendRoomUpdate);
            } else {
              modPhase.opponentQueue = newQueue;
              modPhase.cardPlayedThisCycle = false;
              updateModifierPhaseGameState(roomCode, modPhase, gameState);
            }
          } else {
            finalizeRoll(roomCode, modPhase, gameState, sendRoomUpdate);
          }
        } else {
          updateModifierPhaseGameState(roomCode, modPhase, gameState);
        }
      }
    }

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

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});