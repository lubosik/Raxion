import { sleep } from '../lib_utils.js';

const baseUrl = 'https://api.apify.com/v2';

export async function enrichCandidateContact(linkedinUrl) {
  if (!linkedinUrl || !process.env.APIFY_API_KEY || !process.env.APIFY_ACTOR_ID) {
    return { email: null, phone: null };
  }

  try {
    const actorId = encodeURIComponent(process.env.APIFY_ACTOR_ID);
    const response = await fetch(`${baseUrl}/acts/${actorId}/run-sync-get-dataset-items`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.APIFY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ profileUrls: [linkedinUrl] }),
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      console.error('[apify] enrichment failed', response.status, await response.text());
      return { email: null, phone: null };
    }

    const items = await response.json();
    const first = items?.[0] || {};
    const email = first.email || first.emailAddress || null;
    const phone = first.phone || first.phoneNumber || null;
    console.log(`[apify] enrichment ${linkedinUrl} -> ${email || phone ? 'found' : 'not found'}`);
    return { email, phone };
  } catch (error) {
    console.error('[apify] enrichment error', { linkedinUrl, error: error.message });
    return { email: null, phone: null };
  }
}

export async function enrichCandidateBatch(candidates = []) {
  const results = [];
  for (const candidate of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const enriched = await enrichCandidateContact(candidate.linkedin_url);
    results.push({ candidateId: candidate.id, ...enriched });
    // eslint-disable-next-line no-await-in-loop
    await sleep(2000);
  }
  return results;
}
