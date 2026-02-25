import { multiaddr } from "@multiformats/multiaddr";
import { createLibp2p } from "libp2p";
import { tcp } from "@libp2p/tcp";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";

const node = await createLibp2p({ transports:[tcp()], connectionEncrypters:[noise()], streamMuxers:[yamux()] });
await node.start();
// Get node2 peer_id from live API
const res = await fetch("http://localhost:4889/info");
const info = await res.json();
const addrs = info?.p2p?.multiaddrs ?? [];
const target = addrs.find(a => a.includes("127.0.0.1"));
if (!target) { console.log("❌ No multiaddr found for node2"); process.exit(1); }
console.log("Dialing:", target);
try {
  const conn = await node.dial(multiaddr(target));
  console.log("✅ P2P dial OK — peer:", conn.remotePeer.toString().slice(0,20)+"...");
} catch(e) {
  console.log("❌ P2P dial failed:", e.message);
}
await node.stop();
