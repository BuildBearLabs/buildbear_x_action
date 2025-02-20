const { randomBytes } = require("crypto");
const { default: axios } = require("axios");

/**
 * Creates a sandbox node and returns the BuildBear RPC URL.
 *
 * @param {string} repoName - The repository name
 * @param {string} commitHash - The commit hash
 * @param {number} chainId - The chain ID for the fork
 * @param {number} blockNumber - The block number for the fork
 * @returns {string} - The BuildBear RPC URL for the sandbox node
 */
async function createNode(repoName, commitHash, chainId, blockNumber) {
  try {
    const sandboxId = `${repoName}-${commitHash.slice(0, 8)}-${randomBytes(4).toString("hex")}`;
    const url = "https://api.buildbear.io/v1/buildbear-sandbox";
    const bearerToken = core.getInput("buildbear-token", { required: true });

    const data = {
      chainId: Number(chainId),
      nodeName: sandboxId.toString(),
      blockNumber: blockNumber ? Number(blockNumber) : undefined,
    };

    const response = await axios.post(url, data, {
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        "Content-Type": "application/json",
      },
    });

    core.exportVariable("BUILDBEAR_RPC_URL", response.data.rpcUrl);
    core.exportVariable("MNEMONIC", response.data.mnemonic);
    return {
      url: response.data.rpcUrl,
      sandboxId,
    };
  } catch (error) {
    console.error(
      "Error creating node:",
      error.response?.data || error.message,
    );
    throw error;
  }
}

/**
 * Checks if the node is ready by continuously polling for status.
 *
 * @param {string} url - The BuildBear RPC URL
 * @param {number} maxRetries - Maximum number of retries before giving up
 * @param {number} delay - Delay between retries in milliseconds
 * @returns {boolean} - Returns true if the node becomes live, otherwise false
 */
async function checkNodeLiveness(url, maxRetries = 10, delay = 5000) {
  let attempts = 0;
  while (attempts < maxRetries) {
    try {
      const resp = await axios.post(url, {
        jsonrpc: "2.0",
        id: 1,
        method: "eth_chainId",
        params: [],
      });

      // Check if status is 200 and if result is absent
      if (resp.status === 200 && resp.data.result) {
        console.log(`Sandbox is live: ${url}`);
        return true;
      }
    } catch (error) {
      console.log(error);
      console.error(
        `Attempt ${attempts + 1}: Sandbox is not live yet. Retrying...`,
      );
    }

    // Wait for the specified delay before the next attempt
    await new Promise((resolve) => setTimeout(resolve, delay));
    attempts++;
  }

  console.error(`Node did not become live after ${maxRetries} attempts.`);
  return false;
}

module.exports = {
  createNode,
  checkNodeLiveness,
};
