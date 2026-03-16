import supabase from '../db/supabase.js';
import { enrichCandidateContact } from '../integrations/apify.js';
import { sleep } from '../lib_utils.js';
import { logActivity } from './activityLogger.js';

export async function processEnrichmentQueue(jobId = null) {
  let query = supabase
    .from('candidates')
    .select('*')
    .eq('enrichment_status', 'Pending')
    .in('pipeline_stage', ['Shortlisted', 'Enriched', 'invite_sent', 'invite_accepted']);

  if (jobId) query = query.eq('job_id', jobId);

  const { data: candidates } = await query.limit(25);
  const processed = [];

  for (const candidate of candidates || []) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await logActivity(candidate.job_id, candidate.id, 'ENRICHMENT_ATTEMPTED', `Attempting enrichment for ${candidate.name || 'candidate'}`, {
        linkedin_url: candidate.linkedin_url,
      });
      // eslint-disable-next-line no-await-in-loop
      const enriched = await enrichCandidateContact(candidate.linkedin_url);
      const status = enriched.email || enriched.phone ? 'Enriched' : 'No Data';

      // eslint-disable-next-line no-await-in-loop
      await supabase.from('candidates').update({
        email: candidate.email || enriched.email,
        phone: candidate.phone || enriched.phone,
        enrichment_status: status,
        pipeline_stage: candidate.pipeline_stage === 'Shortlisted' && status === 'Enriched' ? 'Enriched' : candidate.pipeline_stage,
      }).eq('id', candidate.id);

      // eslint-disable-next-line no-await-in-loop
      await logActivity(
        candidate.job_id,
        candidate.id,
        status === 'Enriched' ? 'CANDIDATE_ENRICHED' : 'CANDIDATE_ENRICHMENT_NO_DATA',
        `${candidate.name || 'Candidate'} enrichment ${status.toLowerCase()}`,
        enriched,
      );
      processed.push({ candidateId: candidate.id, ...enriched, status });
    } catch (error) {
      // eslint-disable-next-line no-await-in-loop
      await supabase.from('candidates').update({ enrichment_status: 'Failed' }).eq('id', candidate.id);
      // eslint-disable-next-line no-await-in-loop
      await logActivity(candidate.job_id, candidate.id, 'ENRICHMENT_FAILED', `Enrichment failed for ${candidate.name || 'candidate'}: ${error.message}`, {});
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(2000);
  }

  return processed;
}
