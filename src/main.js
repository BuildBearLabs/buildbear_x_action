const core = require('@actions/core')
const path = require('path')
const { validateConfig } = require('./config')
const { logger } = require('./services/logger')
const { deploymentService } = require('./services/deploymentService')

/**
 * Parse network input from action configuration
 *
 * @param {string} networkInput - JSON string of network configurations
 * @returns {Array} Parsed network array
 */
function parseNetworkInput(networkInput) {
  if (!networkInput) {
    return []
  }

  try {
    const networks = JSON.parse(networkInput)

    if (!Array.isArray(networks)) {
      throw new Error('Network input must be an array')
    }

    // Validate network configurations
    for (const network of networks) {
      if (!network.chainId) {
        throw new Error('Each network must have a chainId')
      }

      if (typeof network.chainId !== 'number') {
        throw new Error('chainId must be a number')
      }

      if (
        network.blockNumber !== undefined &&
        typeof network.blockNumber !== 'number'
      ) {
        throw new Error('blockNumber must be a number if provided')
      }
    }

    return networks
  } catch (error) {
    throw new Error(`Invalid network configuration: ${error.message}`)
  }
}

/**
 * Get action inputs with validation
 *
 * @returns {Object} Validated input parameters
 */
function getActionInputs() {
  const networkInput = core.getInput('network', { required: false })
  const deployCommand = core.getInput('deploy-command', { required: false })
  const workingDirectoryInput =
    core.getInput('working-directory', { required: false }) || '.'

  const networks = parseNetworkInput(networkInput)
  const workingDirectory = path.resolve(process.cwd(), workingDirectoryInput)

  logger.debug('Action inputs parsed', {
    networks,
    deployCommand,
    workingDirectory,
  })

  return {
    networks,
    deployCommand,
    workingDirectory,
  }
}

/**
 * Print deployment summary
 *
 * @param {Array} deployments - Array of deployment results
 */
function printDeploymentSummary(deployments) {
  if (deployments.length === 0) {
    logger.info('No deployments to summarize')
    return
  }

  console.log('='.repeat(100))
  logger.deployment('DEPLOYMENT SUMMARY')
  console.log('='.repeat(100))

  deployments.forEach((deployment, index) => {
    console.log(`\nChain ID: ${deployment.chainId}`)

    if (deployment.status === 'failed') {
      logger.error(`Status: Failed - ${deployment.error || 'Unknown error'}`)
      return
    }

    console.log(`Status: ${deployment.status}`)
    console.log(`Sandbox ID: ${deployment.sandboxId}`)
    console.log(`RPC URL: ${deployment.rpcUrl}`)

    // Handle the correct deployment data structure
    if (deployment.deployments && deployment.deployments.contracts) {
      const contracts = deployment.deployments.contracts
      const contractEntries = Object.entries(contracts)

      if (contractEntries.length > 0) {
        console.log('\nDeployed Contracts:')

        contractEntries.forEach(([contractName, contractInfo], idx) => {
          console.log(`\n${idx + 1}. ${contractName}: ${contractInfo.address}`)
          console.log(`   Transaction Hash: ${contractInfo.transactionHash}`)

          if (contractInfo.blockNumber) {
            console.log(`   Block Number: ${contractInfo.blockNumber}`)
          }

          if (contractInfo.gasUsed) {
            console.log(`   Gas Used: ${contractInfo.gasUsed}`)
          }
        })

        // Show additional transaction summary if available
        const transactions = deployment.deployments.transactions || []
        const createTransactions = transactions.filter(
          (tx) => tx.type === 'CREATE'
        )

        if (createTransactions.length > 0) {
          console.log(`\nDeployment Summary:`)
          console.log(
            `   Total Contract Deployments: ${createTransactions.length}`
          )
          console.log(`   Total Transactions: ${transactions.length}`)
        }
      } else {
        console.log('\nNo contracts deployed')
      }
    } else {
      console.log('\nNo deployment data available')
    }

    if (index < deployments.length - 1) {
      console.log('\n' + '='.repeat(100))
    }
  })

  console.log('\n' + '='.repeat(100))
}

/**
 * Main execution function
 */
async function main() {
  try {
    logger.info('Starting BuildBear GitHub Action')

    // Validate configuration
    validateConfig()
    logger.success('Configuration validated successfully')

    // Get and validate inputs
    const { networks, deployCommand, workingDirectory } = getActionInputs()

    logger.info('Action inputs:', {
      networkCount: networks.length,
      hasDeployCommand: !!deployCommand,
      workingDirectory,
    })

    // Execute deployment pipeline
    const deployments = await deploymentService.executeDeploymentPipeline({
      networks,
      deployCommand,
      workingDirectory,
    })

    // Print summary
    printDeploymentSummary(deployments)

    // Set outputs
    core.setOutput('deployments', JSON.stringify(deployments, null, 2))

    logger.success('BuildBear GitHub Action completed successfully')
  } catch (error) {
    logger.error('Action failed', {
      message: error.message,
      stack: error.stack,
    })

    core.setFailed(error.message)
    process.exit(1)
  }
}

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Promise Rejection', {
    reason: reason,
    promise: promise,
  })
  process.exit(1)
})

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', {
    message: error.message,
    stack: error.stack,
  })
  process.exit(1)
})

module.exports = { main }

if (require.main === module) {
  main()
}
