import supabase from '../db/supabase.js';
import { logActivity } from '../services/activityLogger.js';

let cachedToken = null;
let cachedUntil = 0;

async function requestZoho(path, options = {}) {
  const token = await getAccessToken();
  if (!token) return null;

  try {
    const response = await fetch(`${process.env.ZOHO_API_BASE}${path}`, {
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

export async function getAccessToken() {
  if (cachedToken && Date.now() < cachedUntil) return cachedToken;
  if (!process.env.ZOHO_CLIENT_ID || !process.env.ZOHO_CLIENT_SECRET || !process.env.ZOHO_REFRESH_TOKEN) return null;

  try {
    const params = new URLSearchParams({
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      grant_type: 'refresh_token',
    });
    const response = await fetch(`${process.env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.eu'}/oauth/v2/token`, {
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
