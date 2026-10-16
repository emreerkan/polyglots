// Sending a finished rules file to the app maintainers. The endpoint is
// polyglots-admin's, behind the same LiteSpeed proxy as the site, and answers
// no CORS preflight: it is posted same-origin by a relative path, which also
// means the Astro dev server, on another origin, cannot send at all. That is
// expected; the tests drive this with a stubbed fetch.

export const SHARE_ENDPOINT = '/polyglots/api/rules';

export interface ShareFields {
  wporg: string;
  slack: string;
  github: string;
  email: string;
  consent: boolean;
  // The honeypot. Hidden from people and left empty by them; a bot that fills
  // it is answered 200 and stored nowhere, so it is sent as typed.
  website: string;
}

export const emptyShare = (): ShareFields => ({ wporg: '', slack: '', github: '', email: '', consent: false, website: '' });

// The shape the server accepts, checked here only so the button can say what
// is missing before a round trip. The server checks again and has the last word.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Why the file cannot be sent yet, or undefined when it can. Only an invalid
 * file, a missing locale, no way to reach the person, or no consent stops it;
 * the download never depends on any of this.
 */
export function shareBlocker(fields: ShareFields, file: { locale: string; error: string | undefined }): string | undefined {
  if (file.error !== undefined) return 'The file is not valid yet, so it cannot be shared. Fix the error above first.';
  if (file.locale === '') return 'Pick a locale in step 1 first.';
  const email = fields.email.trim();
  // A WordPress.org username is not a way to reach anyone: its profile has no
  // message button. So it counts as a name, never as the contact.
  if (fields.slack.trim() === '' && fields.github.trim() === '' && email === '') {
    return 'Add a Slack or GitHub username, or an email: Slack, GitHub or email is how the maintainer reaches you.';
  }
  if (email !== '' && !EMAIL.test(email)) return 'The email does not look like an address.';
  if (!fields.consent) return 'Tick the checkbox to say you understand how this is kept.';
  return undefined;
}

export type ShareResult = { ok: true; message: string } | { ok: false; message: string };

const DOWNLOAD = 'Your file is still here: use Download.';

// Retry-After in seconds, as the admin sends it, said the way a person reads it.
function later(retryAfter: string | null): string {
  const seconds = Number(retryAfter);
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const minutes = Math.ceil(seconds / 60);
  return minutes <= 1 ? ' Try again in a minute.' : ` Try again in ${minutes} minutes.`;
}

/** Posts the file. Never throws: every failure comes back as one line to show. */
export async function sendRules(
  fetchFn: typeof fetch,
  input: { locale: string; yaml: string; fields: ShareFields },
): Promise<ShareResult> {
  const { fields } = input;
  const optional = (key: 'wporg' | 'slack' | 'github' | 'email') => {
    const value = fields[key].trim();
    return value === '' ? {} : { [key]: value };
  };
  const body = {
    locale: input.locale,
    yaml: input.yaml,
    ...optional('wporg'),
    ...optional('slack'),
    ...optional('github'),
    ...optional('email'),
    consent: true,
    website: fields.website,
  };
  let response: Response;
  try {
    response = await fetchFn(SHARE_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, message: `Not sent: the server could not be reached. ${DOWNLOAD}` };
  }
  if (response.ok) return { ok: true, message: 'Sent. The maintainer may contact you on Slack.' };
  // The admin's errors are JSON with a short reason. Anything else, the
  // proxy's HTML 404 before the endpoint is deployed for one, is named by its
  // status alone rather than printed.
  let reason: string | undefined;
  try {
    const parsed: unknown = await response.json();
    if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { error?: unknown }).error === 'string') {
      reason = (parsed as { error: string }).error.replace(/\s+/g, ' ').trim();
    }
  } catch {
    reason = undefined;
  }
  const wait = response.status === 503 ? later(response.headers.get('retry-after')) : '';
  return {
    ok: false,
    message: `Not sent: ${reason ? `${reason} (${response.status})` : `the server answered ${response.status}`}.${wait} ${DOWNLOAD}`,
  };
}
