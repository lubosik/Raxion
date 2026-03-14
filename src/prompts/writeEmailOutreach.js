export function buildEmailOutreachPrompt(candidateProfile, jobBrief) {
  return `Write a brief recruiting email.\nRules:\n- Tone: direct, human, brief\n- Subject line plus body\n- Body max 150 words\n- Return ONLY valid JSON: { "subject": string, "body": string }\n\nJob brief:\n${JSON.stringify(jobBrief, null, 2)}\n\nCandidate:\n${JSON.stringify(candidateProfile, null, 2)}`;
}

export const emailOutreachSystemPrompt = 'You write concise recruiting emails. Return only valid JSON.';
