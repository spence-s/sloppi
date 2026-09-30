import {writeFile} from 'node:fs/promises';
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';

/**
Adds an opt-in request capture so provider payloads are written only when the
user explicitly asks for one. The temporary file can contain complete prompts
and tool definitions, so it is created with owner-only permissions.
*/
export default function captureRequest(pi: ExtensionAPI): void {
  let isArmed = false;

  pi.registerCommand('capture-request', {
    description: 'Capture the next provider request payload',
    /**
    Arms a one-shot capture before the user sends the prompt they want to
    inspect, avoiding persistent logging of later conversations.
    */
    async handler(_args, ctx) {
      isArmed = true;
      ctx.ui.notify('The next provider request will be captured.', 'info');
    },
  });

  /**
  Writes the finalized provider-specific body without changing it, then
  disarms immediately so retries and subsequent turns are not recorded.
  */
  pi.on('before_provider_request', async (event, ctx) => {
    if (!isArmed) {
      return;
    }

    isArmed = false;

    await writeFile('latest-request.json', `${JSON.stringify(event.payload, null, 2)}\n`);

    if (
      typeof event.payload === 'object'
      && event.payload !== null
      && 'instructions' in event.payload
      && typeof event.payload.instructions === 'string'
    ) {
      await writeFile('last-instructions.txt', event.payload.instructions);
      ctx.ui.notify('Human Readable Instructions captured at latest-instructions.txt', 'info');
    }

    ctx.ui.notify('Provider request captured at latest-request.json', 'info');
  });
}
