import { describe, expect, it, vi } from 'vitest';
import { answerOffline } from './assistant';
import { getState } from '../state/store';

vi.mock('../config', async () => ({ ...await vi.importActual('../config'), API_BASE: null }));

describe('sample assistant explanation', () => {
  it('retains log-odds wording for the synthetic demo model only', async () => {
    const response = await answerOffline('What is SHAP?', getState(), null, Date.now());
    expect(response.answer).toMatch(/raw log-odds units/);
    expect(response.answer).toMatch(/not.*percentage points/);
  });
});
