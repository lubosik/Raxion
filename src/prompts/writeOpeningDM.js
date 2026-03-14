export function buildOpeningDMPrompt(candidateProfile, jobBrief) {
  return `Write a first LinkedIn DM after a connection is accepted.\nRules:\n- Max 120 words\n- Do not mention the job title directly\n- Open with curiosity, not a pitch\n- End with a soft open question\n- Return plain text only\n\nJob brief:\n${JSON.stringify(jobBrief, null, 2)}\n\nCandidate:\n${JSON.stringify(candidateProfile, null, 2)}`;
}

export const openingDMSystemPrompt = 'You write brief, natural LinkedIn outreach. Return plain text only.';
