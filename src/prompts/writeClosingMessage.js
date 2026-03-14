export function buildClosingMessagePrompt(intent, context) {
  return `Write a polite recruiting reply for intent ${intent}.\nRules:\n- Max 2 sentences\n- Warm and human\n- Return plain text only\n\nContext:\n${JSON.stringify(context, null, 2)}`;
}

export const closingMessageSystemPrompt = 'You write short, polite recruiting replies. Return plain text only.';
