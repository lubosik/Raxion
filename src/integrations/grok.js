function getGrokApiKey() {
  return process.env.GROK_API_KEY || process.env.XAI_API_KEY || null;
}

export async function searchWeb(query) {
  const apiKey = getGrokApiKey();
  if (!apiKey) {
    console.warn('[GROK] No API key configured - web search unavailable');
    return null;
  }

  const response = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'grok-3',
      max_tokens: 800,
      messages: [{ role: 'user', content: query }],
      search_parameters: { mode: 'auto' },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Grok API ${response.status}: ${body}`);
  }

  const data = await response.json();
  return data?.choices?.[0]?.message?.content || null;
}
