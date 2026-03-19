const transitions: Record<string, string[]> = {
  OPEN: ['IN_PROGRESS'],
  IN_PROGRESS: ['COMPLETED'],
  COMPLETED: ['CLOSED'],
  CLOSED: [],
};

export function isValidStatusTransition(currentStatus: string, newStatus: string): boolean {
  return transitions[currentStatus]?.includes(newStatus) ?? false;
}
