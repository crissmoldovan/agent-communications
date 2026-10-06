// The page's own script, held to the page's CSP as Playwright's evaluate is not: it records that the bundle loaded,
// that the page is a secure context (so crypto.subtle is there, as in the app's origin), and that code generation from
// a string is refused, as the desktop app's production CSP, which has no 'unsafe-eval', refuses it (design D13).
let evalOutcome = 'ran';
try {
  new Function('');
} catch (error) {
  evalOutcome = error instanceof Error ? error.name : String(error);
}
globalThis.agentcommsBoot = {
  loaded: typeof globalThis.AgentcommsEventsRealm?.run === 'function',
  secureContext: globalThis.isSecureContext === true && typeof globalThis.crypto?.subtle?.digest === 'function',
  evalOutcome,
  evalRefused: evalOutcome === 'EvalError',
};
