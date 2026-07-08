/**
 * Persistent anonymous identity for reconnects: a UUID minted once per browser
 * and presented in every socket handshake. The server keys seats by this id,
 * so refreshing the tab (or a wifi drop) reclaims the same seat — hand, party
 * and all — within the server's grace window.
 */
export const getPlayerId = (): string => {
    let id = localStorage.getItem('playerId');
    if (!id) {
        id = crypto.randomUUID();
        localStorage.setItem('playerId', id);
    }
    return id;
};
