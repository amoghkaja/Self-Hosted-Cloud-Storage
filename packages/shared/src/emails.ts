/** The part after the last "@", lower-cased. */
export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1).toLowerCase();
}

/** "Use your @example.com address." for messages about the rule. */
export function domainMessage(allowedDomains: readonly string[]): string {
  const list = allowedDomains.map((d) => `@${d}`);
  const joined = list.length > 1 ? `${list.slice(0, -1).join(', ')} or ${list.at(-1)}` : list[0];
  return `Only ${joined} addresses can be used here.`;
}

/**
 * Whether an address may sign in / be invited under the "allowed email domains" setting.
 * An empty list means any address. Only exact domains match: "example.com" does not allow
 * "mail.example.com" or "example.com.evil.example".
 */
export function emailAllowed(allowedDomains: readonly string[], email: string): boolean {
  if (allowedDomains.length === 0) return true;
  return allowedDomains.includes(emailDomain(email));
}
