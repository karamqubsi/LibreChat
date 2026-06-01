import React from 'react';
import { RecoilRoot } from 'recoil';
import { request } from 'librechat-data-provider';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import MCPAppContainer from '../MCPAppContainer';
import { MessagesViewContext } from '~/Providers/MessagesViewContext';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    __esModule: true,
    ...actual,
    request: { ...actual.request, get: jest.fn() },
  };
});

const bridgeInstances: Array<{
  options: any;
  start: jest.Mock;
  destroy: jest.Mock;
  teardownResource: jest.Mock;
  sendContextUpdate: jest.Mock;
  sendResourceToSandbox: jest.Mock;
}> = [];

jest.mock('@librechat/client', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  return {
    ThemeContext: React.createContext({ theme: 'light' }),
    isDark: () => false,
  };
});

jest.mock('../createMCPAppBridge', () => ({
  createMCPAppBridge: jest.fn().mockImplementation((options: any) => {
    const instance = {
      options,
      start: jest.fn(),
      destroy: jest.fn(),
      teardownResource: jest.fn().mockResolvedValue({}),
      sendContextUpdate: jest.fn(),
      sendResourceToSandbox: jest.fn(),
    };
    bridgeInstances.push(instance);
    return instance;
  }),
}));

describe('MCPAppContainer fullscreen lifecycle', () => {
  const ask = jest.fn();
  const setMcpAppModelContext = jest.fn();
  const viewContextValue = {
    conversation: null,
    conversationId: null,
    isSubmitting: false,
    abortScroll: false,
    setAbortScroll: jest.fn(),
    ask,
    regenerate: jest.fn(),
    handleContinue: jest.fn(),
    mcpAppModelContext: null,
    setMcpAppModelContext,
    index: 0,
    latestMessage: null,
    setLatestMessage: jest.fn(),
    getMessages: jest.fn(() => []),
    setMessages: jest.fn(),
  } as const;

  const renderWithContext = (node: React.ReactNode) =>
    render(
      <RecoilRoot>
        <MessagesViewContext.Provider value={viewContextValue as any}>
          {node}
        </MessagesViewContext.Provider>
      </RecoilRoot>,
    );

  beforeEach(() => {
    bridgeInstances.length = 0;
    jest.clearAllMocks();
    (request.get as jest.Mock).mockReset();
    (request.get as jest.Mock).mockImplementation(() => new Promise(() => undefined));
  });

  it('keeps the same bridge/iframe instance when switching to fullscreen', async () => {
    renderWithContext(
      <MCPAppContainer
        html="<html><head></head><body>app</body></html>"
        resourceMeta={null}
        serverName="calendar"
        toolResult={{ ok: true }}
        toolArguments={{ id: '123' }}
      />,
    );

    const inlineIframe = screen.getByTitle('MCP App') as HTMLIFrameElement;
    expect(bridgeInstances).toHaveLength(1);

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: inlineIframe.contentWindow,
          data: { method: 'ui/notifications/sandbox-proxy-ready' },
        }),
      );
    });

    expect(bridgeInstances[0].sendResourceToSandbox).toHaveBeenCalledTimes(1);

    act(() => {
      bridgeInstances[0].options.onDisplayModeRequest('fullscreen');
    });

    await waitFor(() => {
      expect(screen.getByLabelText('Close fullscreen')).toBeInTheDocument();
    });

    const fullscreenIframe = screen.getByTitle('MCP App') as HTMLIFrameElement;
    expect(fullscreenIframe).toBe(inlineIframe);
    expect(bridgeInstances).toHaveLength(1);
    expect(bridgeInstances[0].destroy).not.toHaveBeenCalled();
  });

  it('does not re-send sandbox resource on fullscreen transition, preserving app state', async () => {
    renderWithContext(
      <MCPAppContainer
        html="<html><head></head><body>app</body></html>"
        resourceMeta={null}
        serverName="calendar"
        toolResult={{ ok: true }}
        toolArguments={{ id: '123' }}
      />,
    );

    const iframe = screen.getByTitle('MCP App') as HTMLIFrameElement;
    expect(bridgeInstances).toHaveLength(1);

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: iframe.contentWindow,
          data: { method: 'ui/notifications/sandbox-proxy-ready' },
        }),
      );
    });
    expect(bridgeInstances[0].sendResourceToSandbox).toHaveBeenCalledTimes(1);

    act(() => {
      bridgeInstances[0].options.onDisplayModeRequest('fullscreen');
    });

    await waitFor(() => {
      expect(screen.getByLabelText('Close fullscreen')).toBeInTheDocument();
    });

    // Even if a proxy-ready signal arrives again during transition, the host should
    // not re-inject initial HTML, which would reset app state (e.g. PDP -> carousel).
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: iframe.contentWindow,
          data: { method: 'ui/notifications/sandbox-proxy-ready' },
        }),
      );
    });

    expect(bridgeInstances[0].sendResourceToSandbox).toHaveBeenCalledTimes(1);
  });

  it('restores inline view after closing fullscreen without remounting bridge', async () => {
    const { container } = renderWithContext(
      <MCPAppContainer
        html="<html><head></head><body>app</body></html>"
        resourceMeta={null}
        serverName="calendar"
        toolResult={{ ok: true }}
        toolArguments={{ id: '123' }}
      />,
    );

    const iframe = screen.getByTitle('MCP App') as HTMLIFrameElement;
    expect(bridgeInstances).toHaveLength(1);

    act(() => {
      bridgeInstances[0].options.onDisplayModeRequest('fullscreen');
    });

    await waitFor(() => {
      expect(screen.getByLabelText('Close fullscreen')).toBeInTheDocument();
    });
    expect(document.body.style.overflow).toBe('hidden');

    fireEvent.click(screen.getByLabelText('Close fullscreen'));

    await waitFor(() => {
      expect(screen.queryByLabelText('Close fullscreen')).not.toBeInTheDocument();
    });

    const inlineContainer = container.querySelector('.mcp-app-container') as HTMLElement;
    expect(inlineContainer).toBeTruthy();
    expect(document.body.style.overflow).toBe('');
    expect(screen.getByTitle('MCP App')).toBe(iframe);
    expect(bridgeInstances).toHaveLength(1);
    expect(bridgeInstances[0].destroy).not.toHaveBeenCalled();
  });

  it('preserves inline requested height after fullscreen close', async () => {
    const { container } = renderWithContext(
      <MCPAppContainer
        html="<html><head></head><body>app</body></html>"
        resourceMeta={null}
        serverName="calendar"
        toolResult={{ ok: true }}
        toolArguments={{ id: '123' }}
      />,
    );

    expect(bridgeInstances).toHaveLength(1);
    act(() => {
      bridgeInstances[0].options.onSizeChange({ height: 320 });
    });

    const inlineContainer = container.querySelector('.mcp-app-container') as HTMLElement;
    expect(inlineContainer.style.height).toBe('320px');

    act(() => {
      bridgeInstances[0].options.onDisplayModeRequest('fullscreen');
    });

    await waitFor(() => {
      expect(screen.getByLabelText('Close fullscreen')).toBeInTheDocument();
    });

    // Fullscreen resizes should not overwrite saved inline size.
    act(() => {
      bridgeInstances[0].options.onSizeChange({ height: 900 });
    });

    fireEvent.click(screen.getByLabelText('Close fullscreen'));

    await waitFor(() => {
      expect(screen.queryByLabelText('Close fullscreen')).not.toBeInTheDocument();
    });

    expect(inlineContainer.style.height).toBe('320px');
  });

  it('enforces maxHeight from resource metadata for inline resize requests', () => {
    const { container } = renderWithContext(
      <MCPAppContainer
        html="<html><head></head><body>app</body></html>"
        resourceMeta={{ ui: { maxHeight: 280 } }}
        serverName="calendar"
        toolResult={{ ok: true }}
        toolArguments={{ id: '123' }}
      />,
    );

    expect(bridgeInstances).toHaveLength(1);
    act(() => {
      bridgeInstances[0].options.onSizeChange({ height: 900 });
    });

    const inlineContainer = container.querySelector('.mcp-app-container') as HTMLElement;
    expect(inlineContainer.style.height).toBe('280px');
  });

  it('keeps inline mode when fullscreen is disallowed by resource metadata', async () => {
    renderWithContext(
      <MCPAppContainer
        html="<html><head></head><body>app</body></html>"
        resourceMeta={{ ui: { allowFullscreen: false } }}
        serverName="calendar"
        toolResult={{ ok: true }}
        toolArguments={{ id: '123' }}
      />,
    );

    expect(bridgeInstances).toHaveLength(1);
    let mode;
    act(() => {
      mode = bridgeInstances[0].options.onDisplayModeRequest('fullscreen');
    });

    expect(mode).toBe('inline');
    await waitFor(() => {
      expect(screen.queryByLabelText('Close fullscreen')).not.toBeInTheDocument();
    });
  });

  it('renders the inline iframe in normal document flow, reserving its height', () => {
    const { container } = renderWithContext(
      <MCPAppContainer
        html="<html><head></head><body>app</body></html>"
        resourceMeta={null}
        serverName="calendar"
        toolResult={{ ok: true }}
        toolArguments={{ id: '123' }}
      />,
    );

    const iframe = screen.getByTitle('MCP App') as HTMLIFrameElement;
    const placeholder = container.querySelector('.mcp-app-container') as HTMLElement;

    // The iframe lives inside the in-flow placeholder (not a body-level portal),
    // so surrounding message content lays out around it instead of behind it.
    expect(placeholder).toBeTruthy();
    expect(iframe.closest('.mcp-app-container')).toBe(placeholder);

    // The placeholder reserves the app's reported height in normal flow.
    act(() => {
      bridgeInstances[0].options.onSizeChange({ height: 240 });
    });
    expect(placeholder.style.height).toBe('240px');
  });

  it('loads sandbox from opaque-origin data URL bootstrap', async () => {
    (request.get as jest.Mock).mockResolvedValueOnce(
      '<!DOCTYPE html><html><body>sandbox</body></html>',
    );

    renderWithContext(
      <MCPAppContainer
        html="<html><head></head><body>app</body></html>"
        resourceMeta={null}
        serverName="calendar"
        toolResult={{ ok: true }}
        toolArguments={{ id: '123' }}
      />,
    );

    const iframe = screen.getByTitle('MCP App') as HTMLIFrameElement;
    await waitFor(() => {
      expect(request.get).toHaveBeenCalledWith('/api/mcp/sandbox', {
        responseType: 'text',
        headers: { 'Cache-Control': 'no-store' },
      });
      expect(iframe.getAttribute('src')).toContain('data:text/html');
    });
  });

  it('forwards ui/message and ui/update-model-context callbacks into chat context handlers', () => {
    renderWithContext(
      <MCPAppContainer
        html="<html><head></head><body>app</body></html>"
        resourceMeta={null}
        serverName="calendar"
        toolResult={{ ok: true }}
        toolArguments={{ id: '123' }}
      />,
    );

    expect(bridgeInstances).toHaveLength(1);
    act(() => {
      bridgeInstances[0].options.onMessage({
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
      });
    });
    expect(ask).toHaveBeenCalledWith({ text: 'hello' });

    act(() => {
      bridgeInstances[0].options.onModelContextUpdate({
        content: [{ type: 'text', text: 'ctx' }],
        structuredContent: { key: 'value' },
      });
    });
    expect(setMcpAppModelContext).toHaveBeenCalledWith({
      content: [{ type: 'text', text: 'ctx' }],
      structuredContent: { key: 'value' },
    });

    act(() => {
      bridgeInstances[0].options.onModelContextUpdate({ content: [], structuredContent: {} });
    });
    expect(setMcpAppModelContext).toHaveBeenCalledWith(null);
  });
});
