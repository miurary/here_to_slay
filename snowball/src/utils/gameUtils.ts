import type { GameState } from '../../../shared/types';

export const getCardTypeLabel = (card: { cardType: string }, template?: Record<string, unknown>) => {
    const typeLabel = card.cardType.charAt(0).toUpperCase() + card.cardType.slice(1);
    const subtype = template?.subtype as string | undefined;
    if (card.cardType === 'item' && subtype) {
        const subtypeText = subtype.charAt(0).toUpperCase() + subtype.slice(1);
        return `${subtypeText} ${typeLabel}s`;
    }
    return typeLabel;
};

export const findCardInstanceById = (gameState?: GameState, instanceId?: string | null) => {
    if (!instanceId || !gameState) return undefined;
    // search players' zones
    for (const p of Object.values(gameState.players)) {
        for (const zone of ['hand', 'party'] as const) {
        const found = p.zones[zone].find((c) => c.instanceId === instanceId);
        if (found) return found;
        }
    }
    // search active monsters
    const foundMon = gameState.activeMonsters.find((m) => m.instanceId === instanceId);
    if (foundMon) return foundMon as any;
    // search decks
    const foundMain = gameState.mainDeck.find((c) => c.instanceId === instanceId);
    if (foundMain) return foundMain;
    const foundParty = gameState.partyLeaderDeck.find((c) => c.instanceId === instanceId);
    if (foundParty) return foundParty;
    return undefined;
};

export const getTemplateForInstanceId = (gameState?: GameState, instanceId?: string | null) => {
    const inst = findCardInstanceById(gameState, instanceId);
    if (!inst) return undefined;
    return gameState?.cardTemplates[inst.templateId];
};