export type ContactType = 'manager' | 'recruiter';

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

/** Assemble only user-supplied facts; no inferred relationship or fake referral. */
export function outreachDraft(input: DraftInput): string {
  const firstName = input.contactName.trim().split(/\s+/)[0] || 'there';
  const role = input.jobTitle.trim();
  const company = input.company.trim();
  const context = sentence(input.sourceDetail);
  const proof = sentence(input.proof);
  if (!role || !company || !context || !proof) return '';

  if (input.contactType === 'recruiter') {
    return `Hi ${firstName}, I applied for the ${role} role at ${company}. ${context}. In my own work, ${proof}. If you're working on this search, is there a particular problem or skill the team is prioritizing? Happy to send a concise example. Thanks for your time.`;
  }
  return `Hi ${firstName}, I recently applied for the ${role} role at ${company}. ${context}. In my own work, ${proof}. That overlap made me want to reach out directly. If this role is on your team, I'd welcome a short conversation; if not, no need to reply. Thanks for reading.`;
}
