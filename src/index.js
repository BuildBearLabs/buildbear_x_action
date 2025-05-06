const core = require('@actions/core')
const github = require('@actions/github')
const { default: axios } = require('axios')
const { spawn } = require('child_process')
const { randomBytes } = require('crypto')
const fs = require('fs').promises
const path = require('path')
const { getLatestBlockNumber } = require('./network')
const {
  compressBboutIfExists,
} = require('./util/test-resimulation/runCompression')
const {
  sendCompressedDataToBackend,
} = require('./util/test-resimulation/sendCompressedData')
const {
  processContractArtifacts,
} = require('./util/auto-verification/contractArtifactProcessor')
const {
  sendContractArtifactsToBackend,
} = require('./util/auto-verification/sendContractArtifacts')
const { findDirectory } = require('./util/pathOperations')

const API_KEY = core.getInput('buildbear-token', { required: true })

/**
 * Recursively walk through directories
 * @param {string} dir Directory to walk through
 * @returns {AsyncGenerator<{path: string, name: string, isFile: boolean, isDirectory: boolean}>}
 */
async function* walk(dir) {
  const files = await fs.readdir(dir, { withFileTypes: true })
  for (const dirent of files) {
    const res = path.resolve(dir, dirent.name)
    if (dirent.isDirectory()) {
      yield* walk(res)
    } else {
      yield {
        path: res,
        name: dirent.name,
        isFile: dirent.isFile(),
        isDirectory: false,
      }
    }
  }
}

/**
 * Processes broadcast directory to collect deployment information
 * @param {string} chainId Chain identifier
 * @param workingDir
 * @returns {Promise<Object>} Deployment information
 */
async function processBroadcastDirectory(chainId, workingDir) {
  try {
    // Find broadcast and build directories
    const broadcastDir = await findDirectory('broadcast', workingDir)
    if (!broadcastDir) {
      console.log('No broadcast directory found')
      return null
    }

    const buildDir = path.join(workingDir, 'build')

    // Process event ABIs from build directory
    const eventAbi = []
    if (
      await fs
        .access(buildDir)
        .then(() => true)
        .catch(() => false)
    ) {
      for await (const entry of walk(buildDir)) {
        if (entry.isFile && entry.name.endsWith('.json')) {
          const content = await fs.readFile(entry.path, 'utf8')
          const buildJson = JSON.parse(content)
          if (Array.isArray(buildJson.abi)) {
            eventAbi.push(...buildJson.abi.filter((x) => x.type === 'event'))
          }
        }
      }
    }

    // Process deployment data
    const deployments = {
      transactions: [],
      receipts: [],
      libraries: [],
    }

    // Process broadcast files
    for await (const entry of walk(broadcastDir)) {
      if (
        entry.isFile &&
        entry.name === 'run-latest.json' &&
        entry.path.includes(chainId.toString())
      ) {
        console.log(`Processing broadcast file: ${entry.path}`)

        const content = await fs.readFile(entry.path, 'utf8')
        const runLatestJson = JSON.parse(content)

        if (runLatestJson.transactions) {
          deployments.transactions.push(...runLatestJson.transactions)
        }
        if (runLatestJson.receipts) {
          deployments.receipts.push(...runLatestJson.receipts)
        }
        if (runLatestJson.libraries) {
          deployments.libraries.push(...runLatestJson.libraries)
        }
      }
    }

    // Sort receipts by block number
    if (deployments.receipts.length > 0) {
      deployments.receipts.sort(
        (a, b) => parseInt(a.blockNumber) - parseInt(b.blockNumber)
      )

      // Sort transactions based on receipt order
      deployments.transactions.sort((a, b) => {
        const aIndex = deployments.receipts.findIndex(
          (receipt) => receipt.transactionHash === a.hash
        )
        const bIndex = deployments.receipts.findIndex(
          (receipt) => receipt.transactionHash === b.hash
        )
        return aIndex - bIndex
      })

      // Process logs
      deployments.receipts = deployments.receipts.map((receipt) => ({
        ...receipt,
        decodedLogs: receipt.logs.map((log) => {
          try {
            return {
              eventName: 'Event',
              data: log.data,
              topics: log.topics,
            }
          } catch (e) {
            console.log('Error decoding log:', e)
            return null
          }
        }),
      }))
    }

    return deployments
  } catch (error) {
    console.error('Error processing broadcast directory:', error)
    throw error
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
  try {
    const baseUrl = process.env.BUILDBEAR_BASE_URL || 'https://api.buildbear.io'

    const url = `${baseUrl}/ci/webhook/${API_KEY}`
    const data = {
      task: 'create_node',
      payload: {
        repositoryName: github.context.repo.repo,
        repositoryOwner: github.context.repo.owner,
        commitHash: github.context.sha,
        fork: {
          chainId: Number(chainId),
          blockNumber: blockNumber ? Number(blockNumber) : undefined,
        },
      },
    }

    const response = await axios.post(url, data, {
      headers: {
        'Content-Type': 'application/json',
      },
    })

    core.exportVariable('BUILDBEAR_RPC_URL', response.data.sandbox.rpcUrl)
    core.exportVariable('MNEMONIC', response.data.sandbox.mnemonic)

    return {
      url: response.data.sandbox.rpcUrl,
      sandboxId: response.data.sandbox.sandboxId,
    }
  } catch (error) {
    console.error('Error creating node:', error.response?.data || error.message)
    throw error
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
  let attempts = 0
  while (attempts < maxRetries) {
    try {
      const resp = await axios.post(url, {
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_chainId',
        params: [],
      })

      // Check if status is 200 and if result is absent
      if (resp.status === 200 && resp.data.result) {
        console.log(`Sandbox is live: ${url}`)
        return true
      }
    } catch (error) {
      console.log(error)
      console.error(
        `Attempt ${attempts + 1}: Sandbox is not live yet. Retrying...`
      )
    }

    // Wait for the specified delay before the next attempt
    await new Promise((resolve) => setTimeout(resolve, delay))
    attempts++
  }

  console.error(`Node did not become live after ${maxRetries} attempts.`)
  return false
}

/**
 * Processes test artifacts by compressing the bbout directory and sending it to the backend
 * @param {string} workingDir - Working directory where bbout is located
 * @param {Object} options - Options for processing
 * @param {string} options.status - Status of the operation ("success" or "failed")
 * @param {string} options.message - Message describing the operation result
 * @returns {Promise<{compressedFilePath: string|null, metadata: Object|null, response: Object|null}>}
 */
async function processTestResimulationArtifacts(workingDir, options = {}) {
  try {
    console.log('Processing test resimulation artifacts...')

    // Compress bbout directory if it exists
    const { compressedFilePath, metadata } = await compressBboutIfExists(
      workingDir,
      {
        status: options.status || 'success',
        message: options.message || 'Test artifacts processed',
        directoryName: 'bbOut',
      }
    )

    // If no compressed file was created, return early
    if (!compressedFilePath) {
      console.log(
        'No bbout directory found or compression failed. Skipping artifact upload.'
      )
      return { compressedFilePath: null, metadata: null, response: null }
    }

    // Send the compressed file to the backend
    const response = await sendCompressedDataToBackend(
      compressedFilePath,
      metadata
    )

    return { compressedFilePath, metadata, response }
  } catch (error) {
    console.error(`Error processing test artifacts: ${error.message}`)
    return { compressedFilePath: null, metadata: null, response: null }
  }
}

/**
 * Processes contract artifacts for auto verification and sends them to the backend
 * @param {string} workingDir - Working directory where contracts are located
 * @param {Object} options - Options for processing
 * @param {string} options.status - Status of the operation ("success" or "failed")
 * @param {string} options.message - Message describing the operation result
 * @returns {Promise<{artifacts: Object|null, response: Object|null}>}
 */
async function processContractVerificationArtifacts(workingDir, options = {}) {
  try {
    console.log('Processing contract verification artifacts...')

    // Set the directory paths for contract artifacts
    const broadcastDir = await findDirectory('broadcast', workingDir)
    const outDir = await findDirectory('out', workingDir)

    // Check if directories exist
    try {
      await fs.access(broadcastDir)
      await fs.access(outDir)
    } catch (error) {
      console.log(
        `Required directories not found: ${error.message}. Skipping contract verification.`
      )
      return { artifacts: null, response: null }
    }

    // Process contract artifacts
    console.log('Collecting contract artifacts for verification...')
    const contractArtifacts = await processContractArtifacts(
      broadcastDir,
      outDir
    )

    // If no artifacts were found, return early
    if (!contractArtifacts || Object.keys(contractArtifacts).length === 0) {
      console.log('No contract artifacts found. Skipping artifact upload.')
      return { artifacts: null, response: null }
    }

    // Send the artifacts to the backend
    console.log('Sending contract artifacts to backend...')
    const response = await sendContractArtifactsToBackend(contractArtifacts, {
      status: options.status || 'success',
      message:
        options.message || 'Contract artifacts processed for verification',
    })

    return { artifacts: contractArtifacts, response }
  } catch (error) {
    console.error(
      `Error processing contract verification artifacts: ${error.message}`
    )
    return { artifacts: null, response: null }
  }
}

/**
 * Executes the deployment command if provided, otherwise just processes test artifacts.
 *
 * @param {string|null} deployCmd - The command to deploy the contracts (optional)
 * @param {string} workingDir - The working directory
 */
async function executeDeploy(deployCmd, workingDir) {
  let exitCode = 0

  // Only attempt to execute the deploy command if it's provided
  if (deployCmd) {
    console.log(`Executing deploy command: ${deployCmd}`)
    console.log(`Working directory: ${workingDir}`)

    const promise = new Promise((resolve, reject) => {
      const child = spawn(deployCmd, {
        shell: true,
        cwd: workingDir,
        stdio: 'inherit',
        env: {
          ...process.env,
        },
      })

      child.on('error', (error) => {
        console.error(`Error executing deploy command: ${error.message}`)
        reject(error)
      })

      child.on('close', (code) => {
        if (code !== 0) {
          console.error(`Deployment failed with exit code ${code}`)
        } else {
          console.log('Deployment completed successfully')
        }
        resolve(code)
      })
    })

    exitCode = await promise
  } else {
    console.log('No deploy command provided. Skipping deployment execution.')
  }

  // Process test resimulation artifacts regardless of whether deployment was executed
  await processTestResimulationArtifacts(workingDir, {
    status: exitCode === 0 ? 'success' : 'failed',
    message: deployCmd
      ? exitCode === 0
        ? 'Deployment completed successfully'
        : `Deployment failed with exit code ${exitCode}`
      : 'Processing test artifacts only (no deployment)',
  })

  // Process the auto verification artifacts regardless of whether deployment was executed
  await processContractVerificationArtifacts(workingDir, {
    status: exitCode === 0 ? 'success' : 'failed',
    message: deployCmd
      ? exitCode === 0
        ? 'Deployment completed successfully'
        : `Deployment failed with exit code ${exitCode}`
      : 'Processing contract artifacts only (no deployment)',
  })
}

/**
 * Extracts relevant contract data for notification
 * @param {Object|Array} data - Deployment data to extract from
 * @returns {Array} - Array of extracted contract data
 */
const extractContractData = (data) => {
  const arrayData = Array.isArray(data) ? data : [data] // Ensure data is an array

  return arrayData.map((item) => ({
    chainId: item.chainId || null,
    rpcUrl: item.rpcUrl || null,
    sandboxId: item.sandboxId || null,
    transactions: Array.isArray(item.deployments?.transactions)
      ? item.deployments.transactions
          .filter((tx) => tx.contractName && tx.hash && tx.contractAddress) // Filter out incomplete transactions
          .map((tx) => ({
            contractName: tx.contractName,
            hash: tx.hash,
            contractAddress: tx.contractAddress,
          }))
      : [], // Default to an empty array if transactions are missing
  }))
}

/**
 * Sends deployment notification to the backend service
 * @param {Object} deploymentData - The deployment data to send
 */
async function sendNotificationToBackend(deploymentData) {
  try {
    const githubActionUrl = `https://github.com/${github.context.repo.owner}/${github.context.repo.repo}/actions/runs/${github.context.runId}`
    // Use BUILDBEAR_BASE_URL if it exists, otherwise use the hard-coded URL
    const baseUrl = process.env.BUILDBEAR_BASE_URL || 'https://api.buildbear.io'
    const notificationEndpoint = `${baseUrl}/ci/webhook/${API_KEY}`

    let status = deploymentData.status
    let summary = deploymentData.summary ?? ''
    let deployments = []

    // Process deployment data if not "deployment started" or already "failed"
    if (status !== 'started' && status !== 'failed') {
      // Extract contract data
      deployments = extractContractData(deploymentData.deployments)

      // Validate deployment success
      const validation = validateDeployment(deployments)

      if (!validation.valid) {
        // Update status to failed if validation fails
        status = 'failed'
        summary = validation.message
      }
    }

    const payload = {
      timestamp: new Date().toISOString(),
      status: status,
      payload: {
        runAttempt: process.env.GITHUB_RUN_ATTEMPT,
        runId: github.context.runId.toString(),
        runNumber: github.context.runNumber,
        repositoryName: github.context.repo.repo,
        repositoryOwner: github.context.repo.owner,
        actionUrl: githubActionUrl,
        commitHash: github.context.sha,
        branch: github.context?.ref?.replace('refs/heads/', ''),
        author: github.context.actor,
        message: summary,
        deployments: deployments,
      },
    }

    console.log('Payload:', JSON.stringify(payload, null, 2))

    await axios.post(notificationEndpoint, payload)

    // If the status was changed to failed, we should fail the GitHub Action
    if (status === 'failed' && deploymentData.status !== 'failed') {
      core.setFailed(summary)
    }
  } catch (error) {
    console.log(error)
    // Don't throw error to prevent action failure due to notification issues
  }
}

/**
 * Validates if deployment was successful by checking if any valid transactions exist
 * @param {Array} extractedData - Data extracted from deployments
 * @returns {Object} - Validation result with status and message
 */
const validateDeployment = (extractedData) => {
  // Check if we have any valid transactions across all deployments
  const hasValidTransactions = extractedData.some(
    (deployment) =>
      deployment.transactions && deployment.transactions.length > 0
  )

  if (!hasValidTransactions) {
    return {
      valid: false,
      message:
        'No contract deployments found. All transactions are missing required data.',
    }
  }

  return {
    valid: true,
    message: 'Deployment successful',
  }
}

;(async () => {
  try {
    let deploymentNotificationData = {
      status: 'started',
    }
    await sendNotificationToBackend(deploymentNotificationData)
    // Get the input values
    // Get the input values
    const networkInput = core.getInput('network', { required: false })
    const network = networkInput ? JSON.parse(networkInput) : []
    const deployCmd = core.getInput('deploy-command', { required: false })

    const workingDir = path.join(
      process.cwd(),
      core.getInput('working-directory', {
        required: false,
      })
    )
    const repoName = github.context.repo.repo // Get repository name
    const commitHash = github.context.sha // Get commit hash

    console.log('Network details:', network)
    console.log(`Deploy command: ${deployCmd}`)

    // Initialize array to store all deployments
    const allDeployments = []

    // Only process networks if any are provided
    if (network && network.length > 0) {
      // Loop through the network and create nodes
      for (const net of network) {
        console.log(`\n🔄 Processing network with chainId: ${net.chainId}`)

        let blockNumber

        if (net.blockNumber === undefined) {
          // If blockNumber is not present in the network object, retrieve the latest block number
          blockNumber = await getLatestBlockNumber(parseInt(net.chainId))
        } else {
          // If blockNumber is present in the network object, use it
          blockNumber = net.blockNumber
        }

        console.log(`Block number for chainId ${net.chainId}: ${blockNumber}`)
        // Create node
        const { url: rpcUrl, sandboxId } = await createNode(
          repoName,
          commitHash,
          net.chainId,
          blockNumber
        )

        // Check if the node is live by continuously checking until successful or max retries
        const isNodeLive = await checkNodeLiveness(rpcUrl)

        if (isNodeLive) {
          console.log(`\n📄 Executing deployment for chainId ${net.chainId}`)
          // 5 seconds delay before logging the URL
          setTimeout(() => {}, 5000)

          // Execute the deploy command after node becomes live
          await executeDeploy(deployCmd, workingDir)

          // Process broadcast directory
          const deploymentData = await processBroadcastDirectory(
            net.chainId,
            workingDir
          )

          // Set deployment details as output
          const deploymentDetails = {
            chainId: net.chainId,
            rpcUrl,
            sandboxId,
            status: 'success',
            deployments: deploymentData,
          }

          // Add to deployments array
          allDeployments.push(deploymentDetails)
        } else {
          console.error(
            `Node is not live for URL: ${rpcUrl}. Skipping deployment.`
          )
        }
      }
    } else {
      console.log(
        'No network configuration provided. Skipping node creation and deployment.'
      )
      // Even without a network, process artifacts in the working directory
      if (workingDir) {
        await executeDeploy(deployCmd, workingDir)
      }
    }

    console.log('='.repeat(100))
    // Print final summary for all deployments
    console.log('\n\n🚀🚀 DEPLOYMENT SUMMARY')
    console.log('='.repeat(100))

    allDeployments.forEach((deployment, index) => {
      console.log(`\nChain ID: ${deployment.chainId}`)

      if (deployment.status === 'failed') {
        console.log(`Status: ❌ Failed`)
        console.log(`Error: ${deployment.error}`)
        console.log('='.repeat(100))
        return
      }

      console.log(`Sandbox ID: ${deployment.sandboxId}`)
      console.log(`RPC URL: ${deployment.rpcUrl}`)
      console.log('\nDeployed Contracts:')

      if (deployment.deployments && deployment.deployments.receipts) {
        deployment.deployments.receipts
          .filter((receipt) => receipt.contractAddress)
          .forEach((receipt, idx) => {
            const transaction = deployment.deployments.transactions.find(
              (tx) =>
                tx.contractAddress?.toLowerCase() ===
                receipt.contractAddress?.toLowerCase()
            )
            const contractName = transaction
              ? transaction.contractName
              : 'Unknown Contract'

            console.log(
              `\n${idx + 1}. ${contractName}: ${receipt.contractAddress || 'N/A'}`
            )
            console.log(`   Transaction Hash: ${receipt.transactionHash}`)
            console.log(`   Block Number: ${receipt.blockNumber}`)
            console.log(`   Gas Used: ${receipt.gasUsed}`)
            console.log(`   Cumulative Gas Used : ${receipt.cumulativeGasUsed}`)
            console.log(`   Effective Gas Price : ${receipt.effectiveGasPrice}`)
          })
      }

      // Add separator between deployments
      if (index < allDeployments.length - 1) {
        console.log('\n' + '='.repeat(100))
      }
    })

    deploymentNotificationData = {
      status: 'success',
      deployments: allDeployments,
    }
    await sendNotificationToBackend(deploymentNotificationData)
  } catch (error) {
    let deploymentNotificationData = {
      status: 'failed',
      summary: `Deployment failed`,
      deployments: [],
    }
    await sendNotificationToBackend(deploymentNotificationData)

    core.setFailed(error.message)
  }
})()
