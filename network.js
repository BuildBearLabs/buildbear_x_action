const FALLBACK_MAX_REORG = 200;

const RPC_URL = {
  1: { index: 0, urls: ["https://rpc.ankr.com/eth"] },
  56: { index: 0, urls: ["https://rpc.ankr.com/bsc"] },
  137: { index: 0, urls: ["https://rpc.ankr.com/polygon"] },
  80002: {
    index: 0,
    urls: ["https://rpc.ankr.com/polygon_amoy"],
  },

  10: { index: 0, urls: ["https://rpc.ankr.com/optimism"] },
  42161: { index: 0, urls: ["https://rpc.ankr.com/arbitrum"] },
  421614: { index: 0, urls: ["https://rpc.ankr.com/arbitrum_sepolia"] },
  11155111: {
    index: 0,
    urls: ["https://rpc.ankr.com/eth_sepolia"],
  },
  43114: { index: 0, urls: ["https://rpc.ankr.com/avalanche"] },
  2222: { index: 0, urls: ["https://evm.kava.io"] },
  1101: { index: 0, urls: ["https://zkevm-rpc.com"] },
  59144: { index: 0, urls: ["https://rpc.linea.build"] },
  59141: { index: 0, urls: ["https://rpc.sepolia.linea.build"] },
  100: { index: 0, urls: ["https://rpc.ankr.com/gnosis"] },
  97: {
    index: 0,
    urls: ["https://rpc.ankr.com/bsc_testnet_chapel"],
  },
  165: { index: 0, urls: ["https://testnet.omni.network"] },
  17000: { index: 0, urls: ["https://rpc.ankr.com/eth_holesky"] },
};

function getRpc(chainId) {
  const index = RPC_URL[chainId].index;
  RPC_URL[chainId].index = (index + 1) % RPC_URL[chainId].urls.length;

  const url = RPC_URL[chainId].urls[index];
  return url;
}

async function getLatestBlockNumber(chainId) {
  const url = getRpc(chainId);

  const requestData = {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_blockNumber",
    params: [],
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestData),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    return parseInt(data.result, 16) - FALLBACK_MAX_REORG; // Convert hex to decimal
  } catch (error) {
    console.error("Error fetching the latest block number:", error);
    throw error;
  }
}

// Export the function correctly
module.exports = {
  getLatestBlockNumber,
};
