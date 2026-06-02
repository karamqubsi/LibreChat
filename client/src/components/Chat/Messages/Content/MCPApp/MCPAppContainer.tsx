import React, { useEffect, useRef, useState, useCallback, useContext } from 'react';
import { request } from 'librechat-data-provider';
import { ThemeContext, isDark } from '@librechat/client';
import { createMCPAppBridge, type MCPAppBridgeLike } from './createMCPAppBridge';
import type { McpUiResourceCsp, McpUiResourcePermissions } from './mcpAppUtils';
import { normalizePermissions } from './mcpAppUtils';
import { useLocalize } from '~/hooks';
import { MessagesViewContext } from '~/Providers/MessagesViewContext';

interface ResourceMeta {
  ui?: {
    csp?: McpUiResourceCsp;
    permissions?: McpUiResourcePermissions;
    prefersBorder?: boolean;
    maxHeight?: number;
    allowFullscreen?: boolean;
  };
}

const DEFAULT_MAX_HEIGHT = 800;
const SANDBOX_ENDPOINT = '/api/mcp/sandbox';

function buildOpaqueSandboxSrc(html: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function getTextFromContentBlock(block: unknown): string {
  if (typeof block === 'string') {
    return block;
  }
  if (!block || typeof block !== 'object') {
    return '';
  }
  const maybeRecord = block as Record<string, unknown>;
  if (maybeRecord.type === 'text' && typeof maybeRecord.text === 'string') {
    return maybeRecord.text;
  }
  if (
    maybeRecord.type === 'text' &&
    maybeRecord.text &&
    typeof maybeRecord.text === 'object' &&
    typeof (maybeRecord.text as Record<string, unknown>).value === 'string'
  ) {
    return (maybeRecord.text as Record<string, unknown>).value as string;
  }
  return '';
}

function messageContentToText(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim();
  }
  if (Array.isArray(content)) {
    const text = content.map(getTextFromContentBlock).filter(Boolean).join('\n').trim();
    if (text.length > 0) {
      return text;
    }
    try {
      return JSON.stringify(content);
    } catch {
      return '';
    }
  }
  if (content == null) {
    return '';
  }
  try {
    return JSON.stringify(content);
  } catch {
    return '';
  }
}

function normalizeModelContextPayload(context: unknown): Record<string, unknown> | null {
  if (!context || typeof context !== 'object') {
    return null;
  }
  const payload = context as Record<string, unknown>;
  const content = payload.content;
  const structuredContent = payload.structuredContent;
  const hasContent = Array.isArray(content) && content.length > 0;
  const hasStructured =
    structuredContent != null &&
    typeof structuredContent === 'object' &&
    Object.keys(structuredContent as Record<string, unknown>).length > 0;

  if (!hasContent && !hasStructured) {
    return null;
  }

  const normalized: Record<string, unknown> = {};
  if (hasContent) {
    normalized.content = content;
  }
  if (hasStructured) {
    normalized.structuredContent = structuredContent;
  }
  return normalized;
}

function resolveMaxHeight(maxHeight: unknown): number {
  const parsed = Number(maxHeight);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MAX_HEIGHT;
  }
  return Math.min(2000, Math.max(100, Math.round(parsed)));
}

function isFullscreenAllowed(value: unknown): boolean {
  return value !== false;
}

interface MCPAppContainerProps {
  html: string;
  resourceMeta: ResourceMeta | null;
  serverName: string;
  toolResult?: unknown;
  toolArguments?: Record<string, unknown>;
}

export default function MCPAppContainer({
  html,
  resourceMeta,
  serverName,
  toolResult,
  toolArguments,
}: MCPAppContainerProps) {
  const messagesViewContext = useContext(MessagesViewContext);
  const ask = messagesViewContext?.ask;
  const setMcpAppModelContext = messagesViewContext?.setMcpAppModelContext;
  const [iframeNode, setIframeNode] = useState<HTMLIFrameElement | null>(null);
  const iframeRef = useCallback((node: HTMLIFrameElement | null) => {
    if (!node) {
      return;
    }
    setIframeNode((prev) => (prev === node ? prev : node));
  }, []);
  const bridgeRef = useRef<MCPAppBridgeLike | null>(null);
  const [inlineIframeHeight, setInlineIframeHeight] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [displayMode, setDisplayMode] = useState<'inline' | 'fullscreen'>('inline');
  const [sandboxSrc, setSandboxSrc] = useState<string>('about:blank');
  const [sandboxBootstrapError, setSandboxBootstrapError] = useState(false);
  const displayModeRef = useRef<'inline' | 'fullscreen'>('inline');
  const sandboxReadyRef = useRef(false);

  const { theme: themeMode } = useContext(ThemeContext);
  const theme = isDark(themeMode) ? 'dark' : 'light';
  const localize = useLocalize();
  const askRef = useRef(ask);
  askRef.current = ask;
  const setMcpAppModelContextRef = useRef(setMcpAppModelContext);
  setMcpAppModelContextRef.current = setMcpAppModelContext;

  // Store stable refs for values that shouldn't trigger bridge recreation
  const htmlRef = useRef(html);
  htmlRef.current = html;
  const resourceMetaRef = useRef(resourceMeta);
  resourceMetaRef.current = resourceMeta;
  const toolResultRef = useRef(toolResult);
  const toolArgumentsRef = useRef(toolArguments);
  const previousResourceRef = useRef<{ html: string; serverName: string } | null>(null);
  useEffect(() => {
    displayModeRef.current = displayMode;
  }, [displayMode]);

  const handleSandboxReady = useCallback(() => {
    if (!bridgeRef.current || sandboxReadyRef.current) {
      return;
    }
    sandboxReadyRef.current = true;

    const permissions = normalizePermissions(resourceMetaRef.current?.ui?.permissions);
    const csp = resourceMetaRef.current?.ui?.csp;
    bridgeRef.current.sendResourceToSandbox(htmlRef.current, csp, permissions);
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const htmlTemplate = await request.get<string>(SANDBOX_ENDPOINT, {
          responseType: 'text',
          headers: { 'Cache-Control': 'no-store' },
        });
        if (!active) {
          return;
        }
        setSandboxBootstrapError(false);
        setSandboxSrc(buildOpaqueSandboxSrc(htmlTemplate));
      } catch (error) {
        console.error('[MCPAppContainer] Failed to bootstrap opaque sandbox source:', error);
        if (active) {
          setSandboxSrc('about:blank');
          setSandboxBootstrapError(true);
          setDisplayMode('inline');
        }
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const iframe = iframeNode;
    if (!iframe) {
      return;
    }

    const previousResource = previousResourceRef.current;
    const resourceChanged =
      previousResource == null ||
      previousResource.html !== html ||
      previousResource.serverName !== serverName;

    if (resourceChanged) {
      previousResourceRef.current = { html, serverName };
      sandboxReadyRef.current = false;
      setInlineIframeHeight(0);
      setRevealed(false);
    }

    const bridge = createMCPAppBridge({
      iframe,
      serverName,
      theme,
      toolResult: toolResultRef.current,
      toolArguments: toolArgumentsRef.current,
      resourceMeta: resourceMetaRef.current as Record<string, unknown> | undefined,
      onSizeChange: ({ height }) => {
        if (height && height > 0) {
          if (displayModeRef.current === 'inline') {
            const maxHeight = resolveMaxHeight(resourceMetaRef.current?.ui?.maxHeight);
            setInlineIframeHeight(Math.min(height, maxHeight));
            // Small delay so the iframe has the correct height before we fade in
            requestAnimationFrame(() => setRevealed(true));
          }
        }
      },
      onOpenLink: (url) => {
        window.open(url, '_blank', 'noopener,noreferrer');
      },
      onMessage: ({ content }) => {
        const text = messageContentToText(content);
        const askHandler = askRef.current;
        if (!text || !askHandler) {
          return;
        }
        askHandler({ text });
      },
      onModelContextUpdate: (context) => {
        const setContext = setMcpAppModelContextRef.current;
        if (!setContext) {
          return;
        }
        setContext(normalizeModelContextPayload(context));
      },
      onDisplayModeRequest: (mode) => {
        const allowFullscreen = isFullscreenAllowed(resourceMetaRef.current?.ui?.allowFullscreen);
        if (!allowFullscreen && mode === 'fullscreen') {
          setDisplayMode('inline');
          return 'inline';
        }
        if (mode === 'fullscreen') {
          setDisplayMode('fullscreen');
          return 'fullscreen';
        }
        setDisplayMode('inline');
        return 'inline';
      },
      displayMode,
      allowFullscreen: isFullscreenAllowed(resourceMetaRef.current?.ui?.allowFullscreen),
    });

    bridgeRef.current = bridge;
    bridge.start();

    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow) {
        return;
      }
      try {
        const msg = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        if (msg?.method === 'ui/notifications/sandbox-proxy-ready') {
          handleSandboxReady();
        }
      } catch {
        // ignore parse errors
      }
    };
    window.addEventListener('message', handleMessage);

    return () => {
      window.removeEventListener('message', handleMessage);
      // Request graceful teardown and wait for acknowledgement when possible.
      void bridge
        .teardownResource({})
        .catch(() => {
          // Ignore teardown failures: the view may have already been removed.
        })
        .finally(() => {
          bridge.destroy();
          if (bridgeRef.current === bridge) {
            bridgeRef.current = null;
          }
        });
    };
    // Recreate the bridge when the bound iframe instance changes (e.g. inline <-> fullscreen),
    // or when rendering source identity changes.
    // Theme updates are handled via sendContextUpdate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iframeNode, html, serverName]);

  // Send context updates when host context inputs change.
  useEffect(() => {
    if (bridgeRef.current) {
      bridgeRef.current.sendContextUpdate(theme, displayMode);
    }
  }, [theme, displayMode, inlineIframeHeight]);

  const allowFullscreen = isFullscreenAllowed(resourceMeta?.ui?.allowFullscreen);

  useEffect(() => {
    if (displayMode !== 'fullscreen') {
      return;
    }
    if (!allowFullscreen) {
      setDisplayMode('inline');
    }
  }, [allowFullscreen, displayMode]);

  useEffect(() => {
    if (displayMode !== 'fullscreen') {
      return;
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setDisplayMode('inline');
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
    };
  }, [displayMode]);

  const showBorder = resourceMeta?.ui?.prefersBorder === true;

  if (sandboxBootstrapError) {
    return (
      <div
        className={`mcp-app-container my-2 ${showBorder ? 'rounded-lg border border-border-medium' : ''}`}
        style={{ maxWidth: '100%', overflow: 'hidden' }}
      >
        <div className="rounded-md border border-border-medium bg-surface-primary px-4 py-3 text-sm">
          <div className="font-medium text-text-primary">{localize('com_ui_mcp_init_failed')}</div>
          <div className="mt-1 text-text-secondary">{localize('com_ui_mcp_app_sandbox_failed')}</div>
        </div>
      </div>
    );
  }

  const fullscreen = displayMode === 'fullscreen';

  // Inline: the iframe renders in normal document flow inside a height-reserving
  // placeholder, so surrounding message content lays out around it naturally.
  // Fullscreen: the same iframe node's wrapper is promoted to a fixed overlay via
  // CSS only (no portal, no remount), preserving the live bridge and app state.
  // NOTE: fullscreen relies on no ancestor in the chat tree establishing a
  // fixed-positioning containing block (transform/filter/perspective/contain) —
  // true today. Portaling to <body> would harden it but remounts the iframe and
  // drops app state, so we keep the same-node approach.
  const wrapperStyle: React.CSSProperties = fullscreen
    ? {
        position: 'fixed',
        inset: 0,
        width: '100vw',
        height: '100vh',
        zIndex: 2147483647,
        background: 'var(--surface-primary)',
        display: 'flex',
        flexDirection: 'column',
      }
    : {
        width: '100%',
        height: '100%',
      };

  const iframeStyle: React.CSSProperties = fullscreen
    ? { width: '100%', flex: 1, minHeight: 0, border: 'none', display: 'block' }
    : { width: '100%', height: '100%', border: 'none', display: 'block' };

  return (
    <div
      className={`mcp-app-container my-2 ${
        showBorder && !fullscreen ? 'rounded-lg border border-border-medium' : ''
      }`}
      style={{
        maxWidth: '100%',
        overflow: 'hidden',
        // Keep opaque in fullscreen: the fixed overlay is a descendant here, and
        // CSS opacity on this placeholder would dim it. Inline still fades in once
        // the app reports a size (revealed).
        opacity: fullscreen || revealed ? 1 : 0,
        height: inlineIframeHeight,
        transition: 'opacity 0.3s ease-out, height 0.35s cubic-bezier(0.16, 1, 0.3, 1)',
      }}
    >
      <div style={wrapperStyle}>
        <div
          className="items-center justify-between border-b border-border-medium px-4 py-2"
          style={{ display: fullscreen ? 'flex' : 'none' }}
        >
          {fullscreen && (
            <>
              <span className="text-sm font-medium text-text-primary">
                {localize('com_ui_mcp_server')}
              </span>
              <button
                onClick={() => setDisplayMode('inline')}
                className="rounded-md p-1 text-text-secondary hover:bg-surface-hover hover:text-text-primary"
                aria-label={localize('com_ui_close_fullscreen')}
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 20 20"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M15 5L5 15M5 5l10 10" />
                </svg>
              </button>
            </>
          )}
        </div>
        <iframe
          ref={iframeRef}
          sandbox="allow-scripts allow-same-origin"
          src={sandboxSrc}
          style={iframeStyle}
          title={localize('com_ui_mcp_app')}
        />
      </div>
    </div>
  );
}
