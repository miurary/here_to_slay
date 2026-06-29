import { describe, it, expect } from 'vitest';
import { loadAllCardTemplates } from '../src/cards.js';

describe('smoke: module + card-data resolution', () => {
  it('resolves .js-specifier imports to .ts source and loads card templates', () => {
    const templates = loadAllCardTemplates();
    expect(templates['h_001']?.name).toBe('Bark Hexer');
    expect(Object.keys(templates).length).toBeGreaterThan(50);
  });
});
