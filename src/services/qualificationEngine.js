import supabase from '../db/supabase.js';
import { callClaude } from '../integrations/claude.js';
import { sendTelegramMessage, getRecruiterChatId } from '../integrations/telegram.js';

export async function assessCandidateQualification(candidate, job, conversationHistory, latestReply) {
  return callClaude(
    `Assess whether this candidate is qualified for the role.\nJob: ${JSON.stringify(job)}\nCandidate: ${JSON.stringify(candidate)}\nConversation history: ${JSON.stringify(conversationHistory)}\nLatest reply: ${latestReply}\nReturn JSON {"qualified":true/false,"reason":"","recommended_next_step":""}.`,
    'You are an expert recruiting qualification engine. Return valid JSON only.',
    { expectJson: true },
  ).catch(() => ({ qualified: false, reason: 'Claude qualification failed', recommended_next_step: 'manual_review' }));
}

export async function generateInterviewBrief(candidate, job, conversationHistory = []) {
  const brief = await callClaude(
    `Generate a recruiter-facing interview brief in JSON.\nCandidate: ${JSON.stringify(candidate)}\nJob: ${JSON.stringify(job)}\nConversation history: ${JSON.stringify(conversationHistory)}\nReturn {"candidate_name":"","current_role":"","key_strengths":["",""],"potential_concerns":[""],"conversation_summary":"","questions_asked":[""],"salary_expectation":"","notice_period":"","motivation":"","recommended_interview_angle":""}.`,
    'You create concise recruiter interview briefs. Return valid JSON only.',
    { expectJson: true },
  ).catch(() => null);

  if (!brief) return null;

  const nextNotes = `${candidate.notes || ''}\n[INTERVIEW_BRIEF_GENERATED]\n${JSON.stringify(brief)}`.trim();
  await supabase.from('candidates').update({ notes: nextNotes }).eq('id', candidate.id);
  await sendTelegramMessage(getRecruiterChatId(), `📋 Interview Brief for ${candidate.name} - ${job.job_title}\n${JSON.stringify(brief, null, 2)}`).catch(() => null);
  return brief;
}
