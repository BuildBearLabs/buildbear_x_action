/**
 * Utility for sending contract artifacts to the backend
 *
 * This module handles sending the contract artifacts to the BuildBear backend
 * for auto verification.
 */

const fs = require('fs').promises
const axios = require('axios')
const path = require('path')
const github = require('@actions/github')

/**
 * Sends the contract artifacts to the backend
 * @param {Object} contractArtifacts - Contract artifacts data
 * @param {Object} metadata - Additional metadata to send with the artifacts
 * @returns {Promise<Object>} - Response from the backend
 */
async function sendContractArtifactsToBackend(
  contractArtifacts,
  metadata = {}
) {
  try {
    console.log('Sending contract artifacts to backend')

    // Get GitHub context information
    const githubActionUrl = `https://github.com/${github.context.repo.owner}/${github.context.repo.repo}/actions/runs/${github.context.runId}`

    // Prepare the webhook payload according to the WebhookRequest interface
    const webhookPayload = {
      status: metadata.status || 'success', // Use "success" or "failed"
      task: 'auto_verification',
      timestamp: new Date().toISOString(),
      payload: {
        repositoryName: github.context.repo.repo,
        repositoryOwner: github.context.repo.owner,
        actionUrl: githubActionUrl,
        commitHash: github.context.sha,
        workflow: github.context.workflow,
        message:
          metadata.message ||
          `Contract artifacts uploaded at ${new Date().toISOString()}`,
        artifacts: contractArtifacts,
      },
    }

    // Use BUILDBEAR_BASE_URL if it exists, otherwise use the hard-coded URL
    const baseUrl = process.env.BUILDBEAR_BASE_URL || 'https://api.buildbear.io'

    // Send to backend
    const response = await axios.post(
      `${baseUrl}/ci/webhook/${API_KEY}`,
      webhookPayload,
      {
        headers: {
          'Content-Type': 'application/json',
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      }
    )

    console.log(
      `Successfully sent contract artifacts to backend. Status: ${response.status}`
    )
    return response.data
  } catch (error) {
    console.error(
      `Error sending contract artifacts to backend: ${error.message}`
    )
    throw error
  }
}

module.exports = {
  sendContractArtifactsToBackend,
}
