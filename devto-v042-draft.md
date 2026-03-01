# Soulprint v0.4.2: On-Chain Peer Discovery — Every AI Agent Node Finds Its Network via Blockchain

*Tags: ai, blockchain, opensource, webdev*

---

What if your AI agent node could discover its entire peer network without ever relying on a central server? That's exactly what Soulprint v0.4.2 delivers with **PeerRegistry** — a smart contract on Base Sepolia that acts as a decentralized phonebook for validator nodes.

## What Is PeerRegistry?

PeerRegistry is a Solidity smart contract deployed on Base Sepolia at `0x452fb66159dFCfC13f2fD9627aA4c56886BfB15b`. It stores a mapping of AI agent nodes — their decentralized identifiers (DIDs), libp2p peer IDs, multiaddrs, and trust scores — fully on-chain and publicly readable by anyone.

Think of it as a blockchain-native version of a DNS directory, but for a peer-to-peer network of AI agents.

## How It Works

The flow is beautifully simple:

1. **Node starts** → reads `getAllPeers()` from the PeerRegistry contract
2. **Discovers peers** → uses their multiaddrs as bootstrap points for P2P connection
3. **Registers self** → calls `registerPeer()` on-chain with its own DID, peer ID, and multiaddr
4. **Stays discoverable** → any future node that joins will find it via the contract

No central bootstrap server. No hardcoded IP addresses that go stale. Just Ethereum state.

## Why It Matters

Traditional P2P networks have a bootstrap problem: how does a new node find its first peers? Most solutions rely on hardcoded "well-known" servers — a single point of failure and a censorship vector.

PeerRegistry eliminates this:

- **No central point of failure** — if every bootstrap server goes down, nodes still discover each other via the blockchain
- **Censorship-resistant** — nobody can remove your node from the registry without your private key (or a governance vote)
- **Verifiable** — every registration and removal is an on-chain transaction, fully auditable

## See It in Action

Once your node is running, you can query its discovered peers in real time:

```bash
# Start your node
npx soulprint-network

# See all peers discovered via on-chain registry
curl http://localhost:4888/network/peers

# Response:
# {
#   "ok": true,
#   "peers": [
#     {
#       "peerDid": "did:key:z6Mkf...",
#       "peerId": "12D3KooW...",
#       "multiaddr": "/ip4/1.2.3.4/tcp/6888/p2p/12D3KooW...",
#       "score": 0,
#       "lastSeen": 1772329618
#     }
#   ],
#   "contract": "0x452fb66159dFCfC13f2fD9627aA4c56886BfB15b"
# }
```

Your node automatically reads the contract on startup, connects to known peers via libp2p, and registers itself — all without any manual configuration.

## Stats Endpoint

```bash
curl http://localhost:4888/network/stats
# registered_peers: 2   ← peers recorded on-chain
# total_peers: 2        ← peers known (chain + P2P gossip)
# p2p_peers: 1          ← active libp2p connections
```

## Join the Network

Run your own Soulprint validator node in one command:

```bash
npx soulprint-network
```

Set `ADMIN_PRIVATE_KEY` to a funded Base Sepolia wallet and your node will auto-register on-chain within seconds of startup.

Want to dive deeper into the contracts, P2P layer, or ZK proof verification? The full source is open at [github.com/manuelariasfz/soulprint](https://github.com/manuelariasfz/soulprint).

Every node you run makes the network stronger. 🌐

---

*Soulprint is an open protocol for decentralized AI agent identity and reputation. v0.4.2 — PeerRegistry live on Base Sepolia.*
