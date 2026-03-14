export function buildInboundClassifyPrompt(messageText, senderInfo) {
  return `Classify this inbound message as CANDIDATE_INBOUND, CLIENT_INBOUND, or NOISE.\n\nReturn ONLY valid JSON:\n{ "classification": string, "reason": string }\n\nSender info:\n${JSON.stringify(senderInfo, null, 2)}\n\nMessage:\n${messageText}`;
}

export const classifyInboundSystemPrompt = 'You classify inbound recruitment-related messages. Return only valid JSON.';
