const core = require('@actions/core');
const github = require('@actions/github');
const { default: axios } = require('axios');
const { exec } = require('child_process');
const { randomBytes } = require('crypto');
const util = require('util');
const fs = require('fs').promises;
const path = require('path');
const { getLatestBlockNumber } = require('./network');

// Promisify exec for better async/await usage
const execAsync = util.promisify(exec);

// Default mnemonic to be used as environment variable
const DEFAULT_MNEMONIC = "test test test test test test test test test test test junk";

// Export mnemonic as environment variable
core.exportVariable('MNEMONIC', DEFAULT_MNEMONIC);

/**
 * Recursively walk through directories
 * @param {string} dir Directory to walk through
 * @returns {AsyncGenerator<{path: string, name: string, isFile: boolean, isDirectory: boolean}>}
 */
async function* walk(dir) {
  const files = await fs.readdir(dir, { withFileTypes: true });
  for (const dirent of files) {
    const res = path.resolve(dir, dirent.name);
    if (dirent.isDirectory()) {
      yield* walk(res);
    } else {
      yield {
        path: res,
        name: dirent.name,
        isFile: dirent.isFile(),
        isDirectory: false
      };
    }
  }
}

/**
 * Find a directory in project root
 * @param {string} targetDir Directory name to find
 * @returns {Promise<string|null>}
 */
async function findDirectory(targetDir) {
  const rootDir = process.cwd();
  try {
    const entries = await fs.readdir(rootDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name === targetDir) {
        return path.join(rootDir, entry.name);
      }
    }
    return null;
  } catch (error) {
    console.error(`Error finding directory ${targetDir}:`, error);
    return null;
  }
}

/**
 * Processes broadcast directory to collect deployment information
 * @param {string} chainId Chain identifier
 * @returns {Promise<Object>} Deployment information
 */
async function processBroadcastDirectory(chainId) {
  try {
    // Find broadcast and build directories
    const broadcastDir = await findDirectory('broadcast');
    if (!broadcastDir) {
      console.log('No broadcast directory found');
      return null;
    }

    const buildDir = path.join(process.cwd(), 'build');

    // Process event ABIs from build directory
    const eventAbi = [];
    if (await fs.access(buildDir).then(() => true).catch(() => false)) {
      for await (const entry of walk(buildDir)) {
        if (entry.isFile && entry.name.endsWith('.json')) {
          const content = await fs.readFile(entry.path, 'utf8');
          const buildJson = JSON.parse(content);
          if (Array.isArray(buildJson.abi)) {
            eventAbi.push(...buildJson.abi.filter(x => x.type === "event"));
          }
        }
      }
    }

    // Process deployment data
    const deployments = {
      transactions: [],
      receipts: [],
      libraries: []
    };

    // Process broadcast files
    for await (const entry of walk(broadcastDir)) {
      if (entry.isFile &&
        entry.name === "run-latest.json" &&
        entry.path.includes(chainId.toString())) {
        console.log(`Processing broadcast file: ${entry.path}`);

        const content = await fs.readFile(entry.path, 'utf8');
        const runLatestJson = JSON.parse(content);

        if (runLatestJson.transactions) {
          deployments.transactions.push(...runLatestJson.transactions);
        }
        if (runLatestJson.receipts) {
          deployments.receipts.push(...runLatestJson.receipts);
        }
        if (runLatestJson.libraries) {
          deployments.libraries.push(...runLatestJson.libraries);
        }
      }
    }

    // Sort receipts by block number
    if (deployments.receipts.length > 0) {
      deployments.receipts.sort((a, b) =>
        parseInt(a.blockNumber) - parseInt(b.blockNumber)
      );

      // Sort transactions based on receipt order
      deployments.transactions.sort((a, b) => {
        const aIndex = deployments.receipts.findIndex(
          receipt => receipt.transactionHash === a.hash
        );
        const bIndex = deployments.receipts.findIndex(
          receipt => receipt.transactionHash === b.hash
        );
        return aIndex - bIndex;
      });

      // Process logs
      deployments.receipts = deployments.receipts.map(receipt => ({
        ...receipt,
        decodedLogs: receipt.logs.map(log => {
          try {
            return {
              eventName: "Event",
              data: log.data,
              topics: log.topics
            };
          } catch (e) {
            console.log('Error decoding log:', e);
            return null;
          }
        })
      }));
    }

    return deployments;
  } catch (error) {
    console.error('Error processing broadcast directory:', error);
    throw error;
  }
}

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
  const sandboxId = `${repoName}-${commitHash.slice(0, 8)}-${randomBytes(4).toString("hex")}`;
  const url = `https://rpc-beta.buildbear.io/submit/${sandboxId}`;

  const data = {
    jsonrpc: "2.0",
    id: 1,
    method: "buildbearInternal_createNode",
    params: [
      {
        fork: { id: chainId.toString(), blockNumber },
        chainId: parseInt(chainId),
      },
    ],
  };

  await axios.post(url, data);

  // Export RPC URL as environment variable for later use
  core.exportVariable('BUILDBEAR_RPC_URL', url);
  return { url, sandboxId };
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
        params: []
      });

      // Check if status is 200 and if result is absent
      if (resp.status === 200 && resp.data.result) {
        console.log(`Sandbox is live: ${url}`);
        return true;
      }
    } catch (error) {
      console.log(error)
      console.error(`Attempt ${attempts + 1}: Sandbox is not live yet. Retrying...`);
    }

    // Wait for the specified delay before the next attempt
    await new Promise(resolve => setTimeout(resolve, delay));
    attempts++;
  }

  console.error(`Node did not become live after ${maxRetries} attempts.`);
  return false;
}

/**
 * Executes the deployment command.
 * 
 * @param {string} deployCmd - The command to deploy the contracts
 */
async function executeDeploy(deployCmd) {
  try {
    const { stdout, stderr } = await execAsync(deployCmd);
    console.log(`Deploy command output: ${stdout}`);
    if (stderr) {
      console.warn(`Deploy command stderr: ${stderr}`);
    }
    console.log('Deployment completed successfully');
  } catch (error) {
    console.error(`Error executing deploy command: ${error.message}`);
    core.setFailed(error.message);
  }
}


(async () => {
  try {
    // Get the input values
    const network = JSON.parse(core.getInput('network'));
    const deployCmd = core.getInput('deployCmd');
    const repoName = github.context.repo.repo; // Get repository name
    const commitHash = github.context.sha; // Get commit hash

    console.log('Network details:', network);
    console.log(`Deploy command: ${deployCmd}`);

    // Initialize array to store all deployments
    const allDeployments = [];

    // Loop through the network and create nodes
    for (const net of network) {

      console.log(`\n🔄 Processing network with chainId: ${net.chainId}`);
      let blockNumber;

      if (net.blockNumber === undefined || net.blockNumber === ""){
        blockNumber = await getLatestBlockNumber(parseInt(net.chainId))
         console.log(blockNumber)
      }

      console.log(blockNumber)
      // Create node
      const { url: rpcUrl, sandboxId } = await createNode(
        repoName,
        commitHash,
        net.chainId,
        blockNumber
      );

      // Check if the node is live by continuously checking until successful or max retries
      const isNodeLive = await checkNodeLiveness(rpcUrl);

      if (isNodeLive) {

        console.log(`\n📄 Executing deployment for chainId ${net.chainId}`);
        // 5 seconds delay before logging the URL
        setTimeout(() => {
        }, 5000);

        // Execute the deploy command after node becomes live
        await executeDeploy(deployCmd);

        // Process broadcast directory
        const deploymentData = await processBroadcastDirectory(net.chainId);

     

        // Set deployment details as output
        const deploymentDetails = {
          chainId: net.chainId,
          rpcUrl,
          sandboxId,
          status: 'success',
          deployments: deploymentData
        };

           // Add to deployments array
           allDeployments.push(deploymentDetails);

      } else {
        console.error(`Node is not live for URL: ${rpcUrl}. Skipping deployment.`);
      }

    }

        console.log('='.repeat(100));
        // Print final summary for all deployments
        console.log('\n\n🚀🚀 DEPLOYMENT SUMMARY');
        console.log('='.repeat(100));
    
        allDeployments.forEach((deployment, index) => {
          console.log(`\nChain ID: ${deployment.chainId}`);
          
          if (deployment.status === 'failed') {
            console.log(`Status: ❌ Failed`);
            console.log(`Error: ${deployment.error}`);
            console.log('='.repeat(100));
            return;
          }
    
          console.log(`Sandbox ID: ${deployment.sandboxId}`);
          console.log(`RPC URL: ${deployment.rpcUrl}`);
          console.log('\nDeployed Contracts:');
          
          if (deployment.deployments && deployment.deployments.receipts) {
            deployment.deployments.receipts.forEach((receipt, idx) => {
              const transaction = deployment.deployments.transactions.find(
                tx => tx.contractAddress?.toLowerCase() === receipt.contractAddress?.toLowerCase()
              );
              const contractName = transaction ? transaction.contractName : 'Unknown Contract';

              console.log(`\n${idx + 1}. ${contractName}: ${receipt.contractAddress || 'N/A'}`);
              console.log(`   Transaction Hash: ${receipt.transactionHash}`);
              console.log(`   Block Number: ${receipt.blockNumber}`);
              console.log(`   Gas Used: ${receipt.gasUsed}`);
              console.log(`   Cumulative Gas Used : ${receipt.cumulativeGasUsed}`);
              console.log(`   Effective Gas Price : ${receipt.effectiveGasPrice}`);
            });
          }
    
          // Add separator between deployments
          if (index < allDeployments.length - 1) {
            console.log('\n' + '='.repeat(100));
          }
        });

  } catch (error) {
    core.setFailed(error.message);
  }
})();
