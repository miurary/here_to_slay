import type { CardInstance, GameState } from '../../../../../shared/types';
import { T, ghostGoldButton } from './tableUtils';
import Tooltip from './Tooltip';

interface ModifierButtonsProps {
  gameState: GameState;
  modifiers: CardInstance[];
  /** The roll context of the open modifier phase (drives conditional upgrades). */
  rollContext?: string;
  onPlay: (modifierInstanceId: string, choiceIndex: number) => void;
}

/**
 * Renders each modifier card in hand as one small ghost-gold button per choice
 * (e.g. "+2" / "−2"), matching the roll/prompt strips. A card with no explicit
 * choices falls back to its single MODIFY_ROLL effect. Each button carries a
 * hover tooltip naming the card it would play.
 */
export default function ModifierButtons({ gameState, modifiers, rollContext, onPlay }: ModifierButtonsProps) {
  return (
    <>
      {modifiers.map((card) => {
        const tmpl = gameState.cardTemplates[card.templateId];
        const name = tmpl?.name ?? 'Modifier';
        const tip = `${name} — ${tmpl?.abilityText ?? ''}`;
        const choices = tmpl?.choices;
        if (choices && choices.length > 0) {
          return choices.map((choice, i) => {
            const upgrade = choice.conditionalUpgrades?.find((u) => u.condition?.rollContext === rollContext);
            const label = upgrade?.label ?? choice.label ?? '?';
            const amount = upgrade?.effects?.[0]?.amount ?? choice.effects?.[0]?.amount ?? 0;
            return (
              <Tooltip key={`${card.instanceId}-${i}`} text={tip}>
                <span
                  onClick={() => onPlay(card.instanceId, i)}
                  style={{ ...ghostGoldButton, color: amount >= 0 ? T.gold : T.red, borderColor: amount >= 0 ? 'oklch(0.5 0.06 85)' : 'oklch(0.5 0.1 25)' }}
                >
                  {label}
                </span>
              </Tooltip>
            );
          });
        }
        const amount = tmpl?.effects?.[0]?.amount ?? 0;
        return (
          <Tooltip key={card.instanceId} text={tip}>
            <span onClick={() => onPlay(card.instanceId, 0)} style={{ ...ghostGoldButton, color: amount >= 0 ? T.gold : T.red }}>
              {amount >= 0 ? '+' : ''}{amount}
            </span>
          </Tooltip>
        );
      })}
    </>
  );
}
