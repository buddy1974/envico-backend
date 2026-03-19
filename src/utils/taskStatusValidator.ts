// Valid status transitions for Envico OS tasks
const TRANSITIONS: Record<string, string[]> = {
  PENDING:     ['IN_PROGRESS'],
  IN_PROGRESS: ['DONE', 'PENDING'],
  DONE:        [], // terminal state

  // Legacy support (old tasks in DB)
  OPEN:        ['ASSIGNED', 'IN_PROGRESS', 'PENDING'],
  ASSIGNED:    ['IN_PROGRESS', 'OPEN'],
  COMPLETED:   [],
};

export function isValidStatusTransition(current: string, next: string): boolean {
  return TRANSITIONS[current]?.includes(next) ?? false;
}
