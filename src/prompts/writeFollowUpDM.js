export function buildFollowUpDMPrompt(candidateProfile, jobBrief, previousMessage) {
  return `Write a follow-up LinkedIn DM using a different angle from the earlier message.\nRules:\n- Max 80 words\n- Acknowledge no reply without guilt-tripping\n- Different angle from the earlier message\n- Return plain text only\n\nPrevious message:\n${previousMessage}\n\nJob brief:\n${JSON.stringify(jobBrief, null, 2)}\n\nCandidate:\n${JSON.stringify(candidateProfile, null, 2)}`;
}

export const followUpDMSystemPrompt = 'You write concise, respectful follow-up DMs. Return plain text only.';
