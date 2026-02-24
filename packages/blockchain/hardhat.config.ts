import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY || "0x0000000000000000000000000000000000000000000000000000000000000001";
const BASESCAN_API_KEY = process.env.BASESCAN_API_KEY || "";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: true,
    },
  },

  networks: {
    // ── Local (Hardhat node) ─────────────────────────────────────────────────
    hardhat: {
      chainId: 31337,
    },

    // ── Base Sepolia (testnet) ───────────────────────────────────────────────
    "base-sepolia": {
      url: "https://sepolia.base.org",
      accounts: [PRIVATE_KEY],
      chainId: 84532,
      gasPrice: "auto",
    },

    // ── Base mainnet ─────────────────────────────────────────────────────────
    "base-mainnet": {
      url: "https://mainnet.base.org",
      accounts: [PRIVATE_KEY],
      chainId: 8453,
      gasPrice: "auto",
    },

    // ── Polygon Amoy (testnet alternativo) ───────────────────────────────────
    "polygon-amoy": {
      url: "https://rpc-amoy.polygon.technology",
      accounts: [PRIVATE_KEY],
      chainId: 80002,
    },
  },

  etherscan: {
    apiKey: {
      "base-sepolia":  BASESCAN_API_KEY,
      "base-mainnet":  BASESCAN_API_KEY,
    },
    customChains: [
      {
        network:  "base-sepolia",
        chainId:  84532,
        urls: {
          apiURL:     "https://api-sepolia.basescan.org/api",
          browserURL: "https://sepolia.basescan.org",
        },
      },
      {
        network:  "base-mainnet",
        chainId:  8453,
        urls: {
          apiURL:     "https://api.basescan.org/api",
          browserURL: "https://basescan.org",
        },
      },
    ],
  },

  gasReporter: {
    enabled:  process.env.REPORT_GAS === "true",
    currency: "USD",
  },

  paths: {
    sources:   "./contracts",
    tests:     "./test",
    cache:     "./cache",
    artifacts: "./artifacts",
  },
};

export default config;
