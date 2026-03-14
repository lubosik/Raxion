export function buildQuestionResponsePrompt(question, jobBrief) {
  return `Answer the candidate's question using only the job brief context. Be helpful, honest, and brief. Return plain text only.\n\nJob brief:\n${JSON.stringify(jobBrief, null, 2)}\n\nQuestion:\n${question}`;
}

export const questionResponseSystemPrompt = 'You answer candidate questions briefly and honestly. Return plain text only.';
