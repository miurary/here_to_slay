export interface ClientToServerEvents {
  pingServer: () => void;
  setUsername: (username: string) => void;
  startGame: () => void;
  rollForFirst: () => void;
  continueGame: () => void;
  choosePartyLeader: (instanceId: string) => void;
  drawFromMain: () => void;
  endTurn: () => void;
  quitGame: () => void;
}

export interface ServerToClientEvents {
  pongClient: (data: { message: string }) => void;
  playersUpdated: (connectedPlayers: PlayerState[]) => void;
  stateUpdate: (state: GameState) => void;
  actionFailed: (message: string) => void;
  cardDrawn: (card: { instanceId: string; templateId: string }) => void;
}

// need to fix clanker code
export type GameStatus = 'waiting' | 'rolling' | 'roll_complete' | 'party_leader_selection' | 'party_leader_review' | 'in_progress' | 'finished';
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
  availablePartyLeaderCards: CardInstance[];
  partyLeaderSelectionOrder: string[];
  currentSelectionPlayerId: string | undefined;
  rollWinnerId: string | undefined;
  lobbyLeaderId: string | undefined;
  currentRollerId: string | undefined;
  firstPlayerId: string | undefined;
  targetMonstersToWin: number | undefined;
}
// need to fix clanker code
export type Player = PlayerState;

export interface PlayerState {
  id: string;
  username: string | undefined;
  actionPoints: number;
  partyLeaderId: string | undefined;
  zones: {
    hand: CardInstance[];
    party: CardInstance[];
    discardPile: CardInstance[];
  };
}

// need to fix clanker code
export interface CardInstance {
  instanceId: string;
  templateId: string;
  cardType: CardType;
  equippedItem?: string;
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