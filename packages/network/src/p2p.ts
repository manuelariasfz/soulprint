/**
 * p2p.ts — stub (v0.6.0)
 * libp2p removed. The blockchain IS the network.
 * This file exists only for backward compatibility with any external imports.
 * @deprecated Use PeerRegistryClient for peer discovery.
 */

export const TOPIC_ATTESTATIONS = "soulprint:attestations:v1";
export const TOPIC_NULLIFIERS   = "soulprint:nullifiers:v1";
export const MAINNET_BOOTSTRAP: string[] = [];

export type P2PConfig = {
  port?: number;
  bootstraps?: string[];
  localOnly?: boolean;
};

export type P2PStats = {
  peerId: string;
  peers: number;
  pubsubPeers: number;
  multiaddrs: string[];
};

export type SoulprintP2PNode = never;

/** @deprecated No-op stub */
export async function createSoulprintP2PNode(_cfg?: P2PConfig): Promise<never> {
  throw new Error("libp2p removed in v0.6.0 — use blockchain peer discovery");
}

/** @deprecated No-op stub */
export async function publishAttestationP2P(_node: any, _att: any): Promise<number> {
  return 0;
}

/** @deprecated No-op stub */
export function onAttestationReceived(_node: any, _cb: any): void {}

/** @deprecated No-op stub */
export function getP2PStats(_node: any): P2PStats {
  return { peerId: "", peers: 0, pubsubPeers: 0, multiaddrs: [] };
}

/** @deprecated No-op stub */
export async function stopP2PNode(_node: any): Promise<void> {}

/** @deprecated No-op stub */
export async function dialP2PPeer(_node: any, _ma: string): Promise<boolean> {
  return false;
}
