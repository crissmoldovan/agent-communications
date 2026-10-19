import { createContext, type ReactNode, useContext } from 'react';
import type { Bridge } from './ipc.ts';

const BridgeContext = createContext<Bridge | null>(null);

/** Hands the screens the bridge they call: Tauri's in the app, a fake one in tests. */
export function BridgeProvider({ bridge, children }: { bridge: Bridge; children: ReactNode }) {
  return <BridgeContext.Provider value={bridge}>{children}</BridgeContext.Provider>;
}

/** The bridge the nearest `BridgeProvider` holds. */
export function useBridge(): Bridge {
  const bridge = useContext(BridgeContext);
  if (bridge === null) throw new Error('useBridge needs a BridgeProvider above it');
  return bridge;
}
