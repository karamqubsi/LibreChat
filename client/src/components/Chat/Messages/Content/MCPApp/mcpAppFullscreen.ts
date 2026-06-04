/**
 * Single-fullscreen coordination for MCP app iframes.
 *
 * Each MCP app renders an independent container. Without coordination, several
 * apps (e.g. ones that auto-request fullscreen on load) would each promote their
 * own wrapper into the top layer and stack, forcing the user to close every
 * overlay to get back to the chat. This module enforces one active fullscreen
 * app per window: the most recent to claim wins, and any other fullscreen app
 * yields back to inline.
 */
let activeId: string | null = null;
const listeners = new Set<() => void>();

const emit = (): void => {
  for (const listener of listeners) {
    listener();
  }
};

export const claimMcpFullscreen = (id: string): void => {
  if (activeId === id) {
    return;
  }
  activeId = id;
  emit();
};

export const releaseMcpFullscreen = (id: string): void => {
  if (activeId !== id) {
    return;
  }
  activeId = null;
  emit();
};

export const subscribeMcpFullscreen = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const getActiveMcpFullscreen = (): string | null => activeId;
