import { EventEmitter } from 'node:events';

const KEEP_ALIVE_MS = 20_000;

export const events = new EventEmitter();
events.setMaxListeners(0);

// Returns an Express handler that streams one shop's events over SSE.
export function sseHandler(slug) {
  return (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders();

    const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), KEEP_ALIVE_MS);

    events.on(slug, send);
    req.on('close', () => {
      clearInterval(keepAlive);
      events.off(slug, send);
    });
  };
}
