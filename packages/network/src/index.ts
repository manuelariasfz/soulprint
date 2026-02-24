export {
  startValidatorNode,
  setP2PNode,
  submitToNode,
  attestBot,
  getBotReputation,
  getNodeInfo,
  BOOTSTRAP_NODES,
} from "./validator.js";

export type { NodeVerifyResult } from "./validator.js";

export {
  createSoulprintP2PNode,
  publishAttestationP2P,
  onAttestationReceived,
  getP2PStats,
  stopP2PNode,
  TOPIC_ATTESTATIONS,
  TOPIC_NULLIFIERS,
  MAINNET_BOOTSTRAP,
} from "./p2p.js";

export type { P2PConfig, P2PStats, SoulprintP2PNode } from "./p2p.js";
