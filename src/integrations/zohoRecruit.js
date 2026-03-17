import supabase from '../db/supabase.js';
import { logActivity } from '../services/activityLogger.js';
import { getRuntimeConfigValue } from '../services/configService.js';

let cachedToken = null;
let cachedUntil = 0;

async function requestZoho(path, options = {}) {
  const apiBase = getRuntimeConfigValue('ZOHO_API_BASE');
  const token = await getAccessToken();
  if (!token || !apiBase) return null;

  try {
    const response = await fetch(`${apiBase}${path}`, {
      ...options,
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });

    if (!response.ok) {
      console.error('[zoho] request failed', { path, status: response.status, body: await response.text() });
      return null;
    }

    return response.status === 204 ? { success: true } : response.json();
  } catch (error) {
    console.error('[zoho] request error', { path, error: error.message });
    return null;
  }
}

export { requestZoho };

export async function getAccessToken() {
  if (cachedToken && Date.now() < cachedUntil) return cachedToken;
  const clientId = getRuntimeConfigValue('ZOHO_CLIENT_ID');
  const clientSecret = getRuntimeConfigValue('ZOHO_CLIENT_SECRET');
  const refreshToken = getRuntimeConfigValue('ZOHO_REFRESH_TOKEN');
  const accountsUrl = getRuntimeConfigValue('ZOHO_ACCOUNTS_URL', 'https://accounts.zoho.eu');
  if (!clientId || !clientSecret || !refreshToken) return null;

  try {
    const params = new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
    });
    const response = await fetch(`${accountsUrl}/oauth/v2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });

    if (!response.ok) {
      console.error('[zoho] token refresh failed', response.status, await response.text());
      return null;
    }

    const payload = await response.json();
    cachedToken = payload.access_token;
    cachedUntil = Date.now() + ((payload.expires_in || 3600) - 60) * 1000;
    return cachedToken;
  } catch (error) {
    console.error('[zoho] token refresh error', error.message);
    return null;
  }
}

export async function createCandidate(candidate) {
  const [firstName, ...rest] = (candidate.name || '').split(' ');
  return requestZoho('/Candidates', {
    method: 'POST',
    body: JSON.stringify({
      data: [{
        First_Name: firstName || 'Unknown',
        Last_Name: rest.join(' ') || firstName || 'Candidate',
        Email: candidate.email || '',
        Mobile: candidate.phone || '',
        Phone: candidate.phone || '',
        Current_Employer: candidate.current_company || '',
        Current_Job_Title: candidate.current_title || '',
        Skill_Set: candidate.tech_skills || '',
        Experience_in_Years: candidate.years_experience || '',
        City: candidate.location || '',
        Country: '',
        Source: 'Raxion AI',
      }],
    }),
  });
}

export async function createJobOpening(job) {
  return requestZoho('/JobOpenings', {
    method: 'POST',
    body: JSON.stringify({
      data: [{
        Job_Opening_Name: job.job_title || job.title || 'Untitled Job',
        Client_Name: job.client_name || '',
        Job_Opening_Status: 'In-progress',
        Job_Type: job.employment_type || 'Full time',
        Remote_Job: /remote/i.test(job.remote_policy || '') || false,
        Required_Skills: job.tech_stack_must || job.must_have_stack || '',
        Job_Description: job.full_job_description || job.raw_brief || job.candidate_profile || '',
        City: job.location || '',
        Number_of_Positions: '1',
        Target_Date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      }],
    }),
  });
}

export async function createInterview(payload) {
  return requestZoho('/Interviews', {
    method: 'POST',
    body: JSON.stringify({ data: [payload] }),
  });
}

export async function updateCandidateStatus(zohoId, status) {
  return requestZoho('/Candidates/status', {
    method: 'PUT',
    body: JSON.stringify({ data: [{ id: zohoId, Candidate_Status: status }] }),
  });
}

export async function syncCandidateToATS(candidate) {
  if (!candidate) return null;

  let response;
  if (candidate.ats_synced && candidate.zoho_candidate_id) {
    response = await updateCandidateStatus(candidate.zoho_candidate_id, candidate.pipeline_stage === 'Placed' ? 'Hired' : 'Qualified');
  } else {
    response = await createCandidate(candidate);
    const zohoId = response?.data?.[0]?.details?.id || response?.data?.[0]?.id || null;
    if (zohoId) {
      await supabase.from('candidates').update({
        zoho_candidate_id: zohoId,
        ats_synced: true,
      }).eq('id', candidate.id);
    }
  }

  await logActivity(candidate.job_id, candidate.id, 'ATS_SYNCED', `Synced ${candidate.name || 'candidate'} to Zoho Recruit`, {
    zoho_candidate_id: candidate.zoho_candidate_id || response?.data?.[0]?.details?.id || null,
  });
  return response;
}

export async function deleteCandidate(zohoId) {
  return requestZoho(`/Candidates/${encodeURIComponent(zohoId)}`, { method: 'DELETE' });
}
