import supabase from '../db/supabase.js';
import { createLinkedInJobPosting, publishLinkedInJobPosting, closeLinkedInJobPosting, getSearchParameters } from '../integrations/unipile.js';
import { fetchAndProcessApplicants } from './inboundApplicantService.js';
import { logActivity } from './activityLogger.js';

function mapWorkplace(remotePolicy) {
  const value = String(remotePolicy || '').toLowerCase();
  if (value.includes('hybrid')) return 'HYBRID';
  if (value.includes('remote')) return 'REMOTE';
  return 'ON_SITE';
}

export async function postJobToLinkedIn(job) {
  const [locations, titles] = await Promise.all([
    getSearchParameters('LOCATION', job.location || ''),
    getSearchParameters('JOB_TITLE', job.job_title || ''),
  ]);

  const draft = await createLinkedInJobPosting({
    job_title: titles?.[0]?.id ? { id: titles[0].id } : { text: job.job_title },
    company: { text: job.client_name },
    workplace: mapWorkplace(job.remote_policy),
    location: locations?.[0]?.id || job.location,
    employment_status: 'FULL_TIME',
    description: job.full_job_description || `<p>${job.job_title}</p>`,
  });

  const draftId = draft?.job_id || draft?.id;
  if (!draftId) return null;

  const published = await publishLinkedInJobPosting(draftId);
  const publishedId = published?.job_id || published?.id || draftId;
  await supabase.from('jobs').update({ linkedin_job_posting_id: publishedId }).eq('id', job.id);
  await logActivity(job.id, null, 'JOB_POSTED_TO_LINKEDIN', `Posted ${job.job_title} to LinkedIn`, { linkedin_job_posting_id: publishedId });
  return published;
}

export async function closeLinkedInJob(job) {
  if (!job.linkedin_job_posting_id) return null;
  const result = await closeLinkedInJobPosting(job.linkedin_job_posting_id);
  await supabase.from('jobs').update({ linkedin_job_posting_id: null }).eq('id', job.id);
  return result;
}

export async function ingestJobApplicants(job) {
  return fetchAndProcessApplicants(job);
}
