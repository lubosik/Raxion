export function buildConnectionNotePrompt(candidateProfile, jobBrief) {
  return `Write a LinkedIn connection request note.\nRules:\n- Max 280 characters\n- Warm, peer-to-peer, not recruiter-bot\n- Reference something specific from the profile\n- Do not use placeholders\n- Return plain text only\n\nJob brief:\n${JSON.stringify(jobBrief, null, 2)}\n\nCandidate:\n${JSON.stringify(candidateProfile, null, 2)}`;
}

export const connectionNoteSystemPrompt = 'You write concise, human LinkedIn notes. Return plain text only.';
