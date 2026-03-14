import supabase from '../db/supabase.js';
import { deleteCandidate as deleteZohoCandidate } from '../integrations/zohoRecruit.js';

export async function deleteCandidateData(candidateId, reason = 'GDPR deletion request', deletedBy = 'recruiter') {
  const { data: candidate } = await supabase.from('candidates').select('*').eq('id', candidateId).single();
  if (!candidate) return { success: false };

  if (candidate.zoho_candidate_id) {
    await deleteZohoCandidate(candidate.zoho_candidate_id).catch(() => null);
  }

  await supabase.from('conversations').delete().eq('candidate_id', candidateId);
  await supabase.from('activity_log').update({
    candidate_id: null,
    summary: 'DELETED',
    detail: { deleted: true },
  }).eq('candidate_id', candidateId);
  await supabase.from('approval_queue').delete().eq('candidate_id', candidateId);
  await supabase.from('gdpr_log').insert({
    candidate_name: candidate.name,
    candidate_email: candidate.email,
    linkedin_url: candidate.linkedin_url,
    reason,
    deleted_by: deletedBy,
  });
  await supabase.from('candidates').delete().eq('id', candidateId);

  return {
    success: true,
    candidate_name: candidate.name,
    deleted_at: new Date().toISOString(),
  };
}
