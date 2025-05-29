/**
 * Utility for sending compressed bbout data to the backend
 *
 * This module handles sending the compressed bbout file to the BuildBear backend
 * for test simulation.
 */

const fs = require('fs').promises
const axios = require('axios')
const path = require('path')
const github = require('@actions/github')
const core = require('@actions/core')

/**
 * Sends the compressed bbout file to the backend
 * @param {string} compressedFilePath - Path to the compressed file
 * @param {Object} metadata - Additional metadata to send with the file
 * @returns {Promise<Object>} - Response from the backend
 */
async function sendCompressedDataToBackend(compressedFilePath, metadata = {}) {
  try {
    console.log(
      `Sending compressed bbout file to backend: ${compressedFilePath}`
    )

    // Read the compressed file
    const fileBuffer = await fs.readFile(compressedFilePath)

    // Convert the file buffer to base64
    const base64File = fileBuffer.toString('base64')

    // Get GitHub context information
    const githubActionUrl = `https://github.com/${github.context.repo.owner}/${github.context.repo.repo}/actions/runs/${github.context.runId}`

    // Prepare the webhook payload according to the WebhookRequest interface
    const webhookPayload = {
      status: metadata.status || 'success', // Use "success" or "failed"
      task: 'simulate_test',
      timestamp: new Date().toISOString(),
      payload: {
        repositoryName: github.context.repo.repo,
        repositoryOwner: github.context.repo.owner,
        actionUrl: githubActionUrl,
        commitHash: github.context.sha,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT,
        runId: github.context.runId.toString(),
        runNumber: github.context.runNumber,
        branch: github.context?.ref?.replace('refs/heads/', ''),
        author: github.context.actor,
        message:
          metadata.message ||
          `Test artifacts uploaded at ${new Date().toISOString()}`,
        testsArtifacts: {
          filename: path.basename(compressedFilePath),
          contentType: 'application/gzip',
          data: base64File,
          metadata: {
            originalSize: metadata.originalSize || 0,
            compressedSize: metadata.compressedSize || 0,
            fileCount: metadata.fileCount || 0,
            timestamp: metadata.timestamp || new Date().toISOString(),
          },
        },
      },
    }

    // Use BUILDBEAR_BASE_URL if it exists, otherwise use the hard-coded URL
    const baseUrl = process.env.BUILDBEAR_BASE_URL || 'https://api.buildbear.io'

    const API_KEY = core.getInput('buildbear-token', { required: true })

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
      `Successfully sent test artifacts to backend. Status: ${response.status}`
    )
    return response.data
  } catch (error) {
    console.error(`Error sending compressed data to backend: ${error.message}`)
    throw error
  }
}

module.exports = {
  sendCompressedDataToBackend,
}
