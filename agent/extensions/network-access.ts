import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {Type} from 'typebox';

const durationSeconds = 60;

export default function networkAccess(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'request_network_access',
    label: 'Request network access',
    description: 'Ask the user to allow one HTTP request scope through the VM proxy for 60 seconds.',
    promptSnippet: 'Request temporary outbound access for a blocked HTTP method, domain, and path',
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
      const isApproved = await ctx.ui.confirm(
        'Allow temporary network access?',
        `Allow ${normalizedMethod} ${scope} for ${durationSeconds} seconds?`,
      );

      if (!isApproved) {
        return {
          content: [{type: 'text' as const, text: `Network access for ${normalizedMethod} ${scope} was denied.`}],
          details: {},
        };
      }

      const result = await pi.exec(
        'sudo',
        ['-n', '/usr/local/sbin/sloppi-allow-request', normalizedMethod, normalizedDomain, normalizedPath],
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
        },
      };
    },
  });
}
