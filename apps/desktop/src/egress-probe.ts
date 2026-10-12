type ProbeApi = {
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
};

const attacks = [
  'fetch',
  'xhr',
  'websocket',
  'eventsource',
  'beacon',
  'image',
  'css',
  'script',
  'frame',
  'form',
  'download',
  'popup',
  'custom',
  'navigation',
] as const;

function api(): ProbeApi {
  const bridge = (window as typeof window & { __TAURI__?: { core?: ProbeApi } }).__TAURI__?.core;
  if (!bridge) throw new Error('probe IPC unavailable');
  return bridge;
}

function requestElement(element: HTMLElement, event: 'load' | 'error'): Promise<void> {
  return new Promise((resolve) => {
    element.addEventListener(event, () => resolve(), { once: true });
    window.setTimeout(resolve, 300);
    document.body.append(element);
  });
}

export async function runEgressProbe(_entry: 'settings' | 'secrets'): Promise<void> {
  const bridge = api();
  const capabilityLabel = await bridge.invoke<string | null>('desktop_probe_capability_mode');
  if (capabilityLabel) {
    const commands = [
      'desktop_target_secret_create',
      'desktop_target_secret_rotate',
      'desktop_target_url_set',
      'desktop_subscriber_token_create',
      'desktop_subscriber_token_rotate',
      'desktop_judge_key_set',
      'desktop_judge_key_rotate',
      'desktop_secrets_migrate',
    ];
    let allowed = 0;
    let denied = 0;
    let excluded = 0;
    for (const command of commands) {
      try {
        const result = await bridge.invoke<{ kind: string; code: string }>(command, {
          input: { id: 'synthetic', version: 1 },
        });
        if (result.kind === 'unavailable' && result.code === 'APP_SECRET_CAPABILITY_UNAVAILABLE') allowed += 1;
      } catch (error) {
        if (capabilityLabel === 'secrets' && error === 'WINDOWS_CONTROL_UNAVAILABLE') allowed += 1;
        else denied += 1;
      }
    }
    if (capabilityLabel === 'secrets') {
      for (const command of ['desktop_control', 'desktop_approve']) {
        try {
          const input =
            command === 'desktop_control'
              ? { request: { operation: 'status', args: {} } }
              : { approvalId: 'synthetic', digest: '0'.repeat(64) };
          await bridge.invoke(command, { input });
        } catch (error) {
          if (
            typeof error === 'string' &&
            (error === 'WINDOW_NOT_AUTHORIZED' || /not allowed|not permitted/i.test(error))
          )
            excluded += 1;
        }
      }
    }
    await bridge.invoke('desktop_probe_report', { report: `capabilities,${allowed},${denied},${excluded}` });
    return;
  }
  const results = new Map<string, boolean>(attacks.map((attack) => [attack, false]));
  const ipc = (await bridge.invoke<string>('desktop_probe_ping')) === 'pong';
  const port = await bridge.invoke<number>('desktop_probe_port');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('probe port unavailable');
  const url = `http://127.0.0.1:${port}/probe`;
  const attempted = (name: (typeof attacks)[number], run: () => unknown) => {
    results.set(name, true);
    try {
      void run();
    } catch {
      /* CSP/native refusal is expected. */
    }
  };

  attempted('fetch', () => fetch(`${url}/fetch`).catch(() => undefined));
  attempted('xhr', () => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', `${url}/xhr`);
    xhr.send();
  });
  attempted('websocket', () => {
    const socket = new WebSocket(`${url.replace('http:', 'ws:')}/websocket`);
    socket.onerror = () => socket.close();
  });
  attempted('eventsource', () => {
    const events = new EventSource(`${url}/eventsource`);
    events.onerror = () => events.close();
  });
  attempted('beacon', () => {
    navigator.sendBeacon(`${url}/beacon`, 'synthetic');
  });
  attempted('image', () => {
    const image = new Image();
    image.src = `${url}/image`;
    document.body.append(image);
  });
  attempted('css', () => {
    const style = document.createElement('link');
    style.rel = 'stylesheet';
    style.href = `${url}/css`;
    void requestElement(style, 'error');
  });
  attempted('script', () => {
    const script = document.createElement('script');
    script.src = `${url}/script`;
    void requestElement(script, 'error');
  });
  attempted('frame', () => {
    const frame = document.createElement('iframe');
    frame.src = `${url}/frame`;
    document.body.append(frame);
  });
  attempted('form', () => {
    const form = document.createElement('form');
    form.action = `${url}/form`;
    form.method = 'POST';
    form.target = '_self';
    document.body.append(form);
    form.requestSubmit();
  });
  attempted('download', () => {
    // A cross-origin download link is only a navigation, which the navigation refusal stops; a same-origin blob
    // download is the one that reaches the native download refusal itself.
    const remote = document.createElement('a');
    remote.href = `${url}/download`;
    remote.download = 'synthetic.txt';
    document.body.append(remote);
    remote.click();
    const local = document.createElement('a');
    local.href = URL.createObjectURL(new Blob(['synthetic'], { type: 'text/plain' }));
    local.download = 'synthetic.txt';
    document.body.append(local);
    local.click();
  });
  attempted('popup', () => {
    window.open(`${url}/popup`, '_blank');
  });
  attempted('custom', () => {
    window.location.assign('desktop-probe://synthetic.test/blocked');
  });
  await new Promise((resolve) => window.setTimeout(resolve, 300));
  attempted('navigation', () => {
    window.location.assign(`${url}/navigation`);
  });
  await new Promise((resolve) => window.setTimeout(resolve, 400));
  const complete = attacks.every((attack) => results.get(attack));
  const sameOrigin =
    window.location.origin === (window.location.protocol === 'tauri:' ? 'tauri://localhost' : 'http://tauri.localhost');
  const report = `complete:${Number(complete)},ipc:${Number(ipc)},origin:${Number(sameOrigin)},attacks:${[...results.entries()].map(([name, done]) => `${name}-${Number(done)}`).join('|')}`;
  await bridge.invoke('desktop_probe_report', { report });
}
