import type { GameState, PlayerState } from '../../../../shared/types';
import { classColor } from '../game/table/tableUtils';

/**
 * Seat palette for the pre-game screens, in join order — the oklch class hues
 * (thief, wizard, necromancer, bard, guardian, berserker) from the design.
 * Used for a player's badge before they've chosen a party leader.
 */
export const SEAT_COLORS = [
  'oklch(0.62 0.13 250)',
  'oklch(0.62 0.13 300)',
  'oklch(0.62 0.13 150)',
  'oklch(0.62 0.13 60)',
  'oklch(0.62 0.13 90)',
  'oklch(0.62 0.13 25)',
] as const;

/** A player's badge color: their leader's class color once chosen, else their seat color. */
export function playerColor(gameState: GameState, player: PlayerState, index: number): string {
  const leaderCls = player.partyLeaderId ? gameState.cardTemplates[player.partyLeaderId]?.class : undefined;
  if (leaderCls) return classColor(leaderCls);
  return SEAT_COLORS[index % SEAT_COLORS.length];
}

/** The party-leader card a player has chosen (present from selection onward), if any. */
export const leaderCardOf = (player: PlayerState) =>
  player.zones.party.find((c) => c.cardType === 'party_leader');
