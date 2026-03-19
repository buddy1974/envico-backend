type Priority = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export function computePriority(task: { status: string; created_at: Date }): Priority {
  if (task.status === 'COMPLETED') return 'LOW';

  const ageHours = (Date.now() - new Date(task.created_at).getTime()) / 3600000;

  if (ageHours > 72) return 'CRITICAL';
  if (ageHours > 48) return 'HIGH';
  if (ageHours > 24) return 'MEDIUM';
  return 'LOW';
}
