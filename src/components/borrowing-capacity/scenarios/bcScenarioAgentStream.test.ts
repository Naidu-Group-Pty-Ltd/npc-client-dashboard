/**
 * The Strategy Advisor says when it has not answered (bcScenarioAgentStream.pure.ts).
 *
 * On 28 Sep 2026 the advisor showed the broker's question and nothing else:
 * its request went to the app's own host, which answered with HTML and a 200,
 * and the stream reader found nothing in it and said nothing about that.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { agentStreamRefusal, emptyAgentAnswerMessage } from './bcScenarioAgentStream.pure';

const AGENT = readFileSync(resolve(__dirname, 'BCScenarioAgent.tsx'), 'utf8');

describe('what the reader accepts as an answer', () => {
  it('accepts the agent stream', () => {
    expect(agentStreamRefusal('text/event-stream')).toBeNull();
    expect(agentStreamRefusal('text/event-stream; charset=utf-8')).toBeNull();
  });

  it("refuses the web app answering in the advisor's place, by name", () => {
    expect(agentStreamRefusal('text/html; charset=utf-8')).toMatch(/answered by the web app/);
  });

  it('refuses anything else, and says what came back', () => {
    expect(agentStreamRefusal('application/json')).toMatch(/unexpected response \(application\/json\)/);
    expect(agentStreamRefusal(null)).toMatch(/unexpected response/);
  });

  it('has a sentence for a stream that carried nothing', () => {
    expect(emptyAgentAnswerMessage()).toMatch(/did not return an answer/);
  });
});

describe('the advisor', () => {
  it('addresses the function through the one module that resolves the project', () => {
    expect(AGENT).toContain("import { SUPABASE_URL } from '@/integrations/supabase/env';");
    expect(AGENT).toContain('`${SUPABASE_URL}/functions/v1/bc-scenario-agent`');
  });

  it('checks what came back before reading it, and refuses an empty turn', () => {
    expect(AGENT.indexOf('agentStreamRefusal(')).toBeLessThan(AGENT.indexOf('resp.body.getReader()'));
    expect(AGENT).toContain('throw new Error(emptyAgentAnswerMessage())');
  });
});
