import { randomInt } from 'node:crypto';

// Cryptographically-strong, unbiased die roll. randomInt(min, max) returns an
// integer in [min, max), so randomInt(1, 7) yields 1–6 with no modulo skew and
// without the predictability of Math.random's PRNG state.
export const rollDie = (): number => randomInt(1, 7);

export const roll2d6 = (): [number, number] => [rollDie(), rollDie()];
