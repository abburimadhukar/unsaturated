export type ContactType = 'manager' | 'recruiter' | 'employee';

export interface DraftInput {
  contactName: string;
  contactType: ContactType;
  company: string;
  jobTitle: string;
  sourceDetail: string;
  proof: string;
}

export function isPublicSourceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function sentence(value: string): string {
  return value.trim().replace(/[.!?\s]+$/, '');
}

/**
 * The one thing the app cannot know, since it no longer stores a resume: the
 * applicant's own relevant result. Left as a clearly-marked blank so a one-click
 * draft is complete and sendable after a single edit, rather than refusing to
 * draft at all. Never a fabricated achievement.
 */
export const PROOF_PLACEHOLDER = '[one sentence on your most relevant result]';

/** Assemble only user-supplied facts; no inferred relationship or fake referral. */
export function outreachDraft(input: DraftInput): string {
  const firstName = input.contactName.trim().split(/\s+/)[0] || 'there';
  const role = input.jobTitle.trim();
  const company = input.company.trim();
  const context = sentence(input.sourceDetail);
  // A missing proof becomes a visible placeholder, not an empty draft. The
  // message still needs a name, role, company and a specific detail to be worth
  // sending, so those stay required.
  const proof = sentence(input.proof) || PROOF_PLACEHOLDER;
  if (!role || !company || !context) return '';

  if (input.contactType === 'recruiter') {
    return `Hi ${firstName}, I applied for the ${role} role at ${company}. ${context}. In my own work, ${proof}. If you're working on this search, is there a particular problem or skill the team is prioritizing? Happy to send a concise example. Thanks for your time.`;
  }
  if (input.contactType === 'employee') {
    return `Hi ${firstName}, I recently applied for the ${role} role at ${company}. ${context}. In my own work, ${proof}. I'd value your perspective on the team's work if you have a moment. No pressure to reply, and thank you for reading.`;
  }
  return `Hi ${firstName}, I recently applied for the ${role} role at ${company}. ${context}. In my own work, ${proof}. That overlap made me want to reach out directly. If this role is on your team, I'd welcome a short conversation; if not, no need to reply. Thanks for reading.`;
}
