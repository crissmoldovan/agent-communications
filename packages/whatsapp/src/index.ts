/**
 * The library entry of `@agentcomms/whatsapp`.
 *
 * Small on purpose, as the Slack package's is: the server, the draft composer, the event list-lock capability and the
 * version. Everything else is reached through the `agent-whatsapp` command.
 */
import { VERSION } from './version.ts';

export { PACKAGE_NAME } from './caller.ts';
export { createWhatsAppMcpServer, type WhatsAppMcpOptions, type WhatsAppMcpServer } from './mcp/server.ts';
export { composeDraft, type DraftResult } from './operations/draft.ts';
export {
  type CurrentEventVisibility,
  type EventSnapshot,
  openWhatsAppEventOperations,
  type WhatsAppEventOperations,
  withCurrentEventVisibility,
  withEventSnapshot,
} from './operations/events.ts';
export type { RawEventMessage } from './source/event-reader.ts';
export { type ChatKind, chatKindOf } from './source/types.ts';
export { Visibility } from './visibility.ts';
export { VERSION };
