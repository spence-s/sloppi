import {createHash, X509Certificate} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {SandboxManager} from '@anthropic-ai/sandbox-runtime';
import {isToolCallEventType, type ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {chromium, type BrowserServer} from 'playwright';
import type {ConfigStore} from './config.ts';

const playwrightCliPath = fileURLToPath(import.meta.resolve('@playwright/cli/playwright-cli.js'));

export class PlaywrightBridge {
  browser: BrowserServer | undefined;
  config: ConfigStore;
  proxyIdentity: string | undefined;
  scratchPath: string | undefined;

  /**
   Keeps optional host-browser automation independent from sandbox session management.
   */
  constructor(config: ConfigStore) {
    this.config = config;
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

      const endpoint = await this.start();
      const cliPath = `'${playwrightCliPath.replaceAll('\'', '\'"\'"\'')}'`;
      const cliConfig = `'${JSON.stringify({browser: {remoteEndpoint: endpoint}}).replaceAll('\'', '\'"\'"\'')}'`;
      event.input.command = [
        'mkdir -p "$TMPDIR/playwright-bin"',
        `ln -sf ${cliPath} "$TMPDIR/playwright-bin/playwright-cli"`,
        String.raw`printf '%s\n' ${cliConfig} > "$TMPDIR/playwright-cli.json"`,
        'export PATH="$TMPDIR/playwright-bin:$PATH" PLAYWRIGHT_MCP_CONFIG="$TMPDIR/playwright-cli.json"',
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
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-extensions',
      '--disable-quic',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--no-first-run',
    ];
    const mitmCA = SandboxManager.getMitmCA();
    if (mitmCA !== undefined) {
      const publicKey = new X509Certificate(mitmCA.certPem).publicKey.export({format: 'der', type: 'spki'});
      args.push(`--ignore-certificate-errors-spki-list=${createHash('sha256').update(publicKey).digest('base64')}`);
    }

    const scratchPath = await mkdtemp(join(tmpdir(), 'sloppi-playwright-'));
    try {
      const browser = await chromium.launchServer({
        args,
        channel: 'chrome',
        env: {
          ...process.env,
          CFFIXED_USER_HOME: scratchPath,
          MAC_CHROMIUM_TMPDIR: scratchPath,
          TMPDIR: scratchPath,
        },
        headless: true,
        host: '127.0.0.1',
        port: 0,
        proxy: {
          server: `http://127.0.0.1:${proxyPort}`,
          username: 'srt',
          password: proxyAuthToken,
          ...(isLocalhostAllowed && {bypass: 'localhost,127.0.0.1,[::1]'}),
        },
      });
      this.browser = browser;
      this.proxyIdentity = proxyIdentity;
      this.scratchPath = scratchPath;
      return browser.wsEndpoint();
    } catch (error) {
      await rm(scratchPath, {force: true, recursive: true});
      throw error;
    }
  }

  /**
   Closes host Chrome and removes files owned solely by the bridge.
   */
  async stop(): Promise<void> {
    const {browser, scratchPath} = this;
    this.browser = undefined;
    this.proxyIdentity = undefined;
    this.scratchPath = undefined;
    try {
      await browser?.close();
    } catch {
      // Chrome may already have exited unexpectedly.
    }

    if (scratchPath !== undefined) {
      await rm(scratchPath, {force: true, recursive: true});
    }
  }
}
