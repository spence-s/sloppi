import {createHash, X509Certificate} from 'node:crypto';
import {SandboxManager} from '@anthropic-ai/sandbox-runtime';
import {isToolCallEventType, type ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {chromium, type BrowserServer} from 'playwright';
import type {ConfigStore} from './config.ts';
import type {SandboxSessionManager} from './session-manager.ts';

export class PlaywrightBridge {
  browser: BrowserServer | undefined;
  config: ConfigStore;
  sandbox: SandboxSessionManager | undefined;
  proxyIdentity: string | undefined;

  /**
   Keeps optional host-browser automation independent from sandbox session management.
   */
  constructor(config: ConfigStore, sandbox?: SandboxSessionManager) {
    this.config = config;
    this.sandbox = sandbox;
  }

  /**
   Registers all user, agent, and session entry points for browser automation.
   */
  register(pi: ExtensionAPI): void {
    pi.registerCommand('playwright', {
      description: 'Enable or disable sandboxed Playwright CLI for this session',
      handler: async (arguments_, ctx) => {
        const action = arguments_.trim();
        if (action === 'on') {
          if (this.sandbox?.isEnabled === false) {
            await this.stop();
            ctx.ui.notify('Sandbox is off; Playwright CLI runs directly on the host.', 'warning');
            return;
          }

          await this.start();
          ctx.ui.notify('Playwright CLI is enabled for this session.', 'info');
          return;
        }

        if (action === 'off') {
          await this.stop();
          ctx.ui.notify('Playwright CLI is disabled.', 'info');
          return;
        }

        if (action === '' || action === 'status') {
          ctx.ui.notify(`Playwright CLI is ${this.isRunning ? 'enabled' : 'disabled'}.`, 'info');
          return;
        }

        ctx.ui.notify('Usage: /playwright [on|off|status]', 'warning');
      },
    });

    pi.on('tool_call', async event => {
      if (!isToolCallEventType('bash', event) || !/\bplaywright-cli(?:\s|$)/v.test(event.input.command)) {
        return;
      }

      if (this.sandbox?.isEnabled === false) {
        await this.stop();
        return;
      }

      const endpoint = await this.start();
      const config = {
        // Keep CLI file access workspace-scoped. https://playwright.dev/agent-cli/configuration#full-config-schema
        allowUnrestrictedFileAccess: false,
        browser: {
          contextOptions: {
            // Start without browser permissions. https://playwright.dev/docs/api/class-browsercontext#browser-context-grant-permissions
            permissions: [],
            // Prevent background persistence and hidden requests. https://playwright.dev/docs/service-workers#how-to-disable-service-workers
            serviceWorkers: 'block' as const,
          },
          // Attach the sandboxed CLI to managed host Chrome. https://playwright.dev/agent-cli/configuration#full-config-schema
          remoteEndpoint: endpoint,
        },
      };
      const cliConfig = `'${JSON.stringify(config).replaceAll('\'', '\'"\'"\'')}'`;
      event.input.command = [
        String.raw`printf '%s\n' ${cliConfig} > "$TMPDIR/playwright-cli.json"`,
        'export PLAYWRIGHT_MCP_CONFIG="$TMPDIR/playwright-cli.json"',
        event.input.command,
      ].join(' && ');
    });

    pi.on('session_shutdown', async () => this.stop());
  }

  /**
   Reports whether this session currently has a host Chrome bridge.
   */
  get isRunning(): boolean {
    return this.browser !== undefined;
  }

  /**
   Launches disposable host Chrome through SRT's authenticated filtering proxy.
   */
  async start(): Promise<string> {
    const proxyPort = SandboxManager.getProxyPort();
    const proxyAuthToken = SandboxManager.getProxyAuthToken();
    if (proxyPort === undefined || proxyAuthToken === undefined) {
      throw new Error('Playwright requires the SRT network proxy.');
    }

    const isLocalhostAllowed = this.config.getEffectiveConfig().network?.allowLocalBinding === true;
    const proxyIdentity = JSON.stringify([proxyPort, proxyAuthToken, isLocalhostAllowed]);
    if (this.browser !== undefined && this.proxyIdentity === proxyIdentity) {
      return this.browser.wsEndpoint();
    }

    await this.stop();

    const args = [
      // Keep browser traffic on TCP where SRT can proxy it. https://peter.sh/experiments/chromium-command-line-switches/#disable-quic
      '--disable-quic',
      // Prevent WebRTC from bypassing the proxy over UDP. https://chromeenterprise.google/policies/web-rtc-ip-handling/
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    ];

    const mitmCA = SandboxManager.getMitmCA();

    if (mitmCA !== undefined) {
      const publicKey = new X509Certificate(mitmCA.certPem).publicKey.export({format: 'der', type: 'spki'});
      // Trust only SRT's generated interception key. https://peter.sh/experiments/chromium-command-line-switches/#ignore-certificate-errors-spki-list
      args.push(`--ignore-certificate-errors-spki-list=${createHash('sha256').update(publicKey).digest('base64')}`);
    }

    const browser = await chromium.launchServer({
      // Pass the two network-hardening switches above. https://playwright.dev/docs/api/class-browsertype#browser-type-launch-option-args
      args,
      // Use the installed stable Chrome. https://playwright.dev/docs/api/class-browsertype#browser-type-launch-option-channel
      channel: 'chrome',
      // Retain Chromium's renderer and process sandbox. https://playwright.dev/docs/api/class-browsertype#browser-type-launch-option-chromium-sandbox
      chromiumSandbox: true,
      // Avoid exposing an interactive host window. https://playwright.dev/docs/api/class-browsertype#browser-type-launch-option-headless
      headless: true,
      // Expose browser control only on loopback. https://playwright.dev/docs/api/class-browsertype#browser-type-launch-server-option-host
      host: '127.0.0.1',
      // Let the OS select an unused loopback port. https://playwright.dev/docs/api/class-browsertype#browser-type-launch-server-option-port
      port: 0,
      // Route web traffic through SRT's authenticated filter. https://playwright.dev/docs/api/class-browsertype#browser-type-launch-option-proxy
      proxy: {
        server: `http://127.0.0.1:${proxyPort}`,
        username: 'srt',
        password: proxyAuthToken,
        ...(isLocalhostAllowed && {bypass: 'localhost,127.0.0.1,[::1]'}),
      },
    });
    this.browser = browser;
    this.proxyIdentity = proxyIdentity;
    return browser.wsEndpoint();
  }

  /**
   Closes host Chrome while tolerating an already-exited browser.
   */
  async stop(): Promise<void> {
    const {browser} = this;
    this.browser = undefined;
    this.proxyIdentity = undefined;
    try {
      await browser?.close();
    } catch {
      // Chrome may already have exited unexpectedly.
    }
  }
}
