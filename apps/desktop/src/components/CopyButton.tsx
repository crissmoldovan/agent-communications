import { Button } from '@cueplusplus/ui';
import { useEffect, useState } from 'react';
import { useBridge } from '../bridge-context.tsx';
import { COPY } from '../copy.ts';

/** `Copy`: puts `text` on the clipboard through the app (`copy_text`), and says so for a moment. */
export function CopyButton({ text, label = COPY.copy }: { text: string; label?: string }) {
  const bridge = useBridge();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={() => {
        bridge
          .copyText(text)
          .then(() => setCopied(true))
          .catch(() => setCopied(false));
      }}
    >
      {copied ? COPY.copied : label}
    </Button>
  );
}
