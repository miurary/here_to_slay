export interface ClientToServerEvents {
  pingServer: () => void;
  setUsername: (username: string) => void;
  startGame: () => void;
  rollForFirst: () => void;
  quitGame: () => void;
}

export interface ServerToClientEvents {
  pongClient: (data: { message: string }) => void;
  playersUpdated: (connectedPlayers: PlayerState[]) => void;
  stateUpdate: (state: GameState) => void;
}

// need to fix clanker code
export type GameStatus = 'waiting' | 'rolling' | 'in_progress' | 'finished';
export type GamePhase = 'DRAW' | 'MAIN' | 'COMBAT' | 'RESOLUTION' | 'END';
export type CardType = 'hero' | 'item' | 'magic' | 'modifier' | 'challenge' | 'monster' | 'party_leader';
export type EffectType = 'damage' | 'heal' | 'draw' | 'buff' | 'challenge' | 'destroy' | 'steal' | 'sacrifice';

export interface CardTemplate {
  id: string;
  name: string;
  type: string;
  class?: string;
  [key: string]: unknown;
}

// need to fix clanker code
export interface GameState {
  gameId: string;
  status: GameStatus;
  activePlayerId: string;
  turnNumber: number;
  phase: GamePhase;
  players: Record<string, PlayerState>;
  stack: StackAction[];
  monsterDeck: CardInstance[];
  partyLeaderDeck: CardInstance[];
  mainDeck: CardInstance[];
  activeMonsters: MonsterInstance[];
  discardedMonsters: CardInstance[];
  discardPile: CardInstance[];
  cardTemplates: Record<string, CardTemplate>;
  diceRolls: Record<string, number>;
  lobbyLeaderId?: string;
  currentRollerId?: string;
  firstPlayerId?: string;
  targetMonstersToWin?: number;
}
// need to fix clanker code
export interface PlayerState {
  id: string;
  username?: string;
  actionPoints: number;
  partyLeaderId?: string;
  zones: {
    hand: CardInstance[];
    party: CardInstance[];
  };
}

// need to fix clanker code
export interface CardInstance {
  instanceId: string;
  templateId: string;
  cardType: CardType;
  equippedItem: string?;
  requirements?: CardRequirements;
  effectUsedThisTurn: boolean;
}

// need to fix clanker code
export interface MonsterInstance extends CardInstance {
  monsterLevel?: number;
  requirementH?: number;
}

// need to fix clanker code
export interface CardRequirements {
  minimumHeroCount?: number;
  heroClasses?: string[];
  monsterRequirement?: number;
  [key: string]: unknown;
}

// need to fix clanker code
export interface StackAction {
  actionId: string;
  sourcePlayerId: string;
  sourceCardInstanceId: string;
  targetInstanceId?: string;
  effectType: EffectType;
  value: number;
  modifierIds?: string[];
}