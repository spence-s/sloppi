import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {Type} from 'typebox';

const durationSeconds = 60;

export default function networkAccess(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'request_network_access',
    label: 'Request network access',
    description: 'Ask the user to allow a blocked request once, permanently for its method/path, or permanently for its domain.',
    promptSnippet: 'Request one-shot outbound access for a blocked HTTP method, domain, and path',
    promptGuidelines: [
      'When the network proxy returns a denial, pass its exact method, domain, and path to request_network_access, then retry after approval.',
    ],
    parameters: Type.Object({
      method: Type.String({description: 'Denied HTTP method, such as POST'}),
      domain: Type.String({description: 'Denied domain name'}),
      path: Type.String({description: 'Exact denied path, or * to allow every path'}),
    }),
    // eslint-disable-next-line max-params -- Pi tool API signature
    async execute(_id, {method, domain, path}, signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        return {
          content: [{type: 'text' as const, text: 'Network access denied: user confirmation is unavailable.'}],
          details: {},
        };
      }

      const normalizedMethod = method.trim().toUpperCase();
      const normalizedDomain = domain.trim().toLowerCase().replace(/\.$/v, '');
      const normalizedPath = path.trim();
      const scope = normalizedPath === '*' ? normalizedDomain : `${normalizedDomain}${normalizedPath}`;
      const choices = [
        `Allow ${normalizedMethod} ${scope} once`,
        `Always allow ${normalizedMethod} ${scope}`,
        `Always allow all requests to ${normalizedDomain}`,
        'Deny',
      ];
      const choice = await ctx.ui.select('Network request denied', choices);

      if (choice === undefined || !choices.includes(choice) || choice === choices[3]) {
        return {
          content: [{type: 'text' as const, text: `Network access for ${normalizedMethod} ${scope} was denied.`}],
          details: {},
        };
      }

      let mode = 'domain';
      if (choice === choices[0]) {
        mode = 'once';
      } else if (choice === choices[1]) {
        mode = 'request';
      }

      const result = await pi.exec(
        'sudo',
        ['-n', '/usr/local/sbin/sloppi-allow-request', mode, normalizedMethod, normalizedDomain, normalizedPath],
        signal === undefined ? {} : {signal},
      );

      if (result.code !== 0) {
        const stderr = result.stderr.trim();
        const stdout = result.stdout.trim();
        const message = stderr.length > 0
          ? stderr
          : (stdout.length > 0 ? stdout : 'Failed to allow domain');
        throw new Error(message);
      }

      return {
        content: [{type: 'text' as const, text: result.stdout.trim()}],
        details: {
          method: normalizedMethod,
          domain: normalizedDomain,
          path: normalizedPath,
          durationSeconds,
          mode,
        },
      };
    },
  });
}
