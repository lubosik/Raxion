import { EventEmitter } from 'node:events';
import supabase from '../db/supabase.js';

export const activityStream = new EventEmitter();

export async function logActivity(jobId, candidateId, eventType, summary, detail = {}) {
  const payload = {
    job_id: jobId || null,
    candidate_id: candidateId || null,
    event_type: eventType,
    summary,
    detail,
  };

  const { data, error } = await supabase.from('activity_log').insert(payload).select('*').single();
  if (error) {
    console.error('[activityLogger] failed to log activity', { eventType, summary, error: error.message });
    return null;
  }

  activityStream.emit('activity', data);
  return data;
}

export async function fetchJobMetrics(jobId) {
  const [{ count: sourced }, { count: outreach }, { count: replies }, { count: qualified }, { count: interviews }, { count: approvals }] = await Promise.all([
    supabase.from('candidates').select('*', { count: 'exact', head: true }).eq('job_id', jobId),
    supabase.from('candidates').select('*', { count: 'exact', head: true }).eq('job_id', jobId).in('pipeline_stage', ['invite_sent', 'invite_accepted', 'dm_sent', 'email_sent', 'Replied', 'Qualified']),
    supabase.from('candidates').select('*', { count: 'exact', head: true }).eq('job_id', jobId).not('last_reply_at', 'is', null),
    supabase.from('candidates').select('*', { count: 'exact', head: true }).eq('job_id', jobId).eq('pipeline_stage', 'Qualified'),
    supabase.from('candidates').select('*', { count: 'exact', head: true }).eq('job_id', jobId).not('interview_booked_at', 'is', null),
    supabase.from('approval_queue').select('*', { count: 'exact', head: true }).eq('job_id', jobId).eq('status', 'pending'),
  ]);

  return {
    candidates_sourced: sourced || 0,
    candidates_in_outreach: outreach || 0,
    replies: replies || 0,
    qualified: qualified || 0,
    interviews_booked: interviews || 0,
    approval_queue_count: approvals || 0,
  };
}
