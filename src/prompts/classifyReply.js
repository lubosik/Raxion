export function buildClassifyReplyPrompt(replyText, jobBrief) {
  return `Classify the candidate reply intent.\nIntent must be one of: INTERESTED, NOT_INTERESTED, MAYBE_LATER, ALREADY_PLACED, REFERRAL, QUESTION, UNCLEAR\n\nReturn ONLY valid JSON:\n{ "intent": string, "confidence": number, "extractedInfo": string }\n\nJob brief:\n${JSON.stringify(jobBrief, null, 2)}\n\nReply:\n${replyText}`;
}

export const classifyReplySystemPrompt = 'You classify recruiting replies. Return only valid JSON.';
