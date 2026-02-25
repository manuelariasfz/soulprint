import { peerIdFromString } from "@libp2p/peer-id";
import { createLibp2p } from "libp2p";
import { tcp } from "@libp2p/tcp";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";

const res = await fetch("http://localhost:4889/info");
const info = await res.json();
const addrs = info?.p2p?.multiaddrs ?? [];
const target = addrs.find(a => a.includes("127.0.0.1"));
if (!target) { console.log("❌ No multiaddr"); process.exit(1); }

const peerIdStr = target.split("/p2p/")[1];
console.log("Target PeerId:", peerIdStr?.slice(0,20)+"...");

const peerId = peerIdFromString(peerIdStr);
console.log("Parsed PeerId:", peerId.toString().slice(0,20)+"...");

const node = await createLibp2p({ transports:[tcp()], connectionEncrypters:[noise()], streamMuxers:[yamux()] });
await node.start();
try {
  const conn = await node.dial(peerId);
  console.log("✅ PeerId dial OK:", conn.remotePeer.toString().slice(0,20)+"...");
} catch(e) {
  console.log("❌ PeerId dial failed:", e.message.slice(0,80));
}
await node.stop();
