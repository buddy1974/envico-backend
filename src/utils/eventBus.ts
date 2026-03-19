type Handler<T = any> = (payload: T) => Promise<void> | void;

const registry = new Map<string, Handler[]>();

export function on<T = any>(event: string, handler: Handler<T>): void {
  if (!registry.has(event)) registry.set(event, []);
  registry.get(event)!.push(handler as Handler);
}

export function emit<T = any>(event: string, payload: T): void {
  const handlers = registry.get(event) ?? [];
  for (const handler of handlers) {
    Promise.resolve(handler(payload)).catch((err) =>
      console.error(`[eventBus] handler error on "${event}":`, err)
    );
  }
}
