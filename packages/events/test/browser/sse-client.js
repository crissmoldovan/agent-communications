function firstFrame(buffer) {
  const end = buffer.indexOf('\n\n');
  return end === -1 ? null : buffer.slice(0, end + 2);
}

globalThis.agentcommsSseClient = {
  async open({ url, token, after, credentials = 'omit' }) {
    try {
      const headers = { Authorization: `Bearer ${token}` };
      if (after !== undefined) headers['Last-Event-ID'] = after;
      const response = await fetch(url, { headers, credentials });
      if (!response.ok) return { ok: false };
      if (after === undefined) return { ok: true };
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let received = '';
      while (true) {
        const next = await reader.read();
        if (next.done) return { ok: false };
        received += decoder.decode(next.value, { stream: true });
        const frame = firstFrame(received);
        if (frame !== null) {
          await reader.cancel();
          return { ok: true, frame };
        }
      }
    } catch {
      return { ok: false };
    }
  },
};
