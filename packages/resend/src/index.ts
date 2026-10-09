/**
 * The library entry of `@agentcomms/resend`.
 *
 * Deliberately small. Everything else is reached through the `agent-resend` command, which ships as a bundle whose
 * internals no caller can import — so what is exported here stays a contract that can be kept.
 *
 * The guard and its permits are **not** exported: a package root that handed out `spendOn` would hand every caller
 * the key to the door the guard exists to keep shut. The route table is exported — knowing what this package may
 * call grants nothing.
 */
import { VERSION } from './version.ts';

export {
  REFUSED,
  RESEND_API_ORIGIN,
  RESEND_DOWNLOAD_ORIGIN,
  ROUTES,
  type Route,
  type RouteKind,
} from './api/routes.ts';
/*
 * This package as core's caller (CUE-403): a core handed to `createResendMcpServer` is opened with it, so every command
 * the server hands a person is this installation's own. Left out, the server opens core that way itself.
 */
export { PACKAGE_NAME, RESEND_CALLER } from './caller.ts';
export { createResendMcpServer, type ResendMcpOptions, type ResendMcpServer } from './mcp/server.ts';
export {
  createResendEventReader,
  createResendEventReaderForPaths,
  normaliseResendEventBody,
  type ResendEventAddress,
  type ResendEventAuthentication,
  type ResendEventReader,
  type ResendEventReceivedAttachment,
  type ResendEventReceivedCandidate,
  type ResendEventReceivedListItem,
  type ResendEventSentItem,
} from './operations/events.ts';
export { VERSION };
