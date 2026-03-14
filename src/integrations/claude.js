import Anthropic from '@anthropic-ai/sdk';
import { logError, normalizeError } from '../lib_errors.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function extractText(response) {
  return (response.content || [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text || '')
    .join('\n')
    .trim();
}

function parseJson(text) {
  const cleaned = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
  return JSON.parse(cleaned);
}

export async function callClaude(prompt, systemPrompt, options = {}) {
  const { expectJson = false, maxTokens = 1000, messages, temperature = 0 } = options;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      temperature,
      system: systemPrompt,
      messages: messages || [{ role: 'user', content: prompt }],
    });

    const text = extractText(response);

    if (!expectJson) {
      return text;
    }

    try {
      return parseJson(text);
    } catch (error) {
      throw new Error(`Claude returned invalid JSON: ${text}`);
    }
  } catch (error) {
    const normalized = normalizeError(error, 'Claude request failed');
    await logError('claude', normalized, 'error');
    throw normalized;
  }
}

export async function extractDocumentData(base64Data, mediaType, prompt, systemPrompt, options = {}) {
  return callClaude('', systemPrompt, {
    ...options,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: mediaType, data: base64Data } },
        { type: 'text', text: prompt },
      ],
    }],
  });
}

export default anthropic;
