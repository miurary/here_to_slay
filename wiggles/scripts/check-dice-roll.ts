import { roll2d6 } from '../src/dice.js';

const ROLLS = 100;
const BAR_WIDTH = 40;

const counts: Record<number, number> = {};
for (let i = 2; i <= 12; i++) counts[i] = 0;

for (let i = 0; i < ROLLS; i++) {
  const [die1, die2] = roll2d6();
  const result = die1 + die2;
  counts[result] = (counts[result] ?? 0) + 1;
}

const max = Math.max(...Object.values(counts));

console.log(`\n2d6 roll distribution (n=${ROLLS})\n`);

for (let total = 2; total <= 12; total++) {
  const count = counts[total] ?? 0;
  const barLen = Math.round((count / max) * BAR_WIDTH);
  const bar = '█'.repeat(barLen);
  const pct = ((count / ROLLS) * 100).toFixed(1);
  console.log(`${String(total).padStart(2)}: ${bar.padEnd(BAR_WIDTH)} ${count} (${pct}%)`);
}

console.log('');
