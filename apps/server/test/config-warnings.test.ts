import { describe, expect, it } from 'vitest';
import { providerKeyWarnings } from '../src/config';
import { testConfig } from './helpers';

/**
 * A provider key in the wrong variable (docs/11 §"Connecting a third-party gateway").
 *
 * This is the failure that looks like nothing: the server starts, `/v1/health` says
 * `cloudKeys.openai: true`, every request is rejected by the wrong vendor, and the orchestrator
 * degrades to the offline engine. The app then "works" but the AI is dumb, and nobody knows why.
 * The prefix is the only clue available before a request is sent — so the server says it out loud.
 */
describe('provider key warnings', () => {
  it('is silent when the keys are in the right variables', () => {
    const config = testConfig({
      OPENAI_API_KEY: 'sk-proj-abc123',
      ANTHROPIC_API_KEY: 'sk-ant-api03-abc123',
      GOOGLE_API_KEY: 'AQ.Ab8RN6Iv8QYniF2XCa2PoHDR',
    });
    expect(providerKeyWarnings(config)).toEqual([]);
  });

  it('names a Gemini key that was pasted into OPENAI_API_KEY', () => {
    // The exact mistake from a real .env: a fresh AI Studio key (AQ.…) in the OpenAI slot.
    const config = testConfig({ OPENAI_API_KEY: 'AQ.Ab8RN6Iv8QYniF2XCa2PoHDRDWjcuRGX' });
    const warnings = providerKeyWarnings(config);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('OPENAI_API_KEY looks like a Google AI Studio key');
    expect(warnings[0]).toContain('GOOGLE_API_KEY');
    // It also names the consequence, not just the fact.
    expect(warnings[0]).toContain('rejected');
  });

  it('catches the other two swaps too', () => {
    expect(providerKeyWarnings(testConfig({ OPENAI_API_KEY: 'AIzaSyD-abcdefgh' }))[0]).toContain('Google AI Studio');
    expect(providerKeyWarnings(testConfig({ OPENAI_API_KEY: 'sk-ant-api03-abc' }))[0]).toContain('Anthropic key');
    expect(providerKeyWarnings(testConfig({ ANTHROPIC_API_KEY: 'sk-proj-abc' }))[0]).toContain('ANTHROPIC_API_KEY looks like an OpenAI');
    expect(providerKeyWarnings(testConfig({ GOOGLE_API_KEY: 'sk-proj-abc' }))[0]).toContain('GOOGLE_API_KEY looks like');
  });

  it('points at an empty key behind a configured gateway', () => {
    const config = testConfig({ OPENAI_BASE_URL: 'https://agentrouter.org/v1' });
    expect(providerKeyWarnings(config)[0]).toContain('OPENAI_API_KEY is empty');
  });

  it('stays quiet about things it cannot know', () => {
    // A reseller key is an opaque string: no prefix can prove it wrong, so we do not guess.
    expect(providerKeyWarnings(testConfig({ OPENAI_API_KEY: 'rp_9f8e7d6c5b4a' }))).toEqual([]);
    expect(providerKeyWarnings(testConfig())).toEqual([]);
  });
});
