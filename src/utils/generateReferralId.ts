export function generateReferralId(): string {
  const year = new Date().getFullYear();
  const random = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `ENV-REF-${year}-${random}`;
}
