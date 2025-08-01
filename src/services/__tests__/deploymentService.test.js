/**
 * Integration tests for DeploymentService foundry artifact changes
 */

const fs = require('fs').promises
const path = require('path')
const os = require('os')
const { DeploymentService, deploymentService } = require('../deploymentService')

// Mock the buildBearApi to avoid actual API calls
jest.mock('../buildBearApi', () => ({
  buildBearApi: {
    sendDeploymentNotification: jest.fn().mockResolvedValue({ success: true }),
  },
}))

// Mock the logger to avoid console output during tests
jest.mock('../logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    progress: jest.fn(),
    error: jest.fn(),
    success: jest.fn(),
  },
}))

describe('DeploymentService - Foundry Artifact Integration', () => {
  let tempDir
  let testWorkingDir
  let originalEnv

  beforeEach(async () => {
    // Save original environment
    originalEnv = { ...process.env }

    // Create temporary directory for tests
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deployment-test-'))
    testWorkingDir = path.join(tempDir, 'project')
    await fs.mkdir(testWorkingDir, { recursive: true })

    // Clear all mocks
    jest.clearAllMocks()
  })

  afterEach(async () => {
    // Restore original environment
    process.env = originalEnv

    // Clean up temporary directory
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })

  describe('sendDeploymentStartedNotification', () => {
    test('should use compressFoundryArtifacts instead of findVmReadFileCalls', async () => {
      // Setup foundry.toml
      const foundryToml = `[profile.default]
src = "src"
out = "out"

[profile.ci]
out = "out-ci"`

      await fs.writeFile(path.join(testWorkingDir, 'foundry.toml'), foundryToml)

      // Create out directory with artifacts
      const outDir = path.join(testWorkingDir, 'out')
      await fs.mkdir(outDir, { recursive: true })

      const contractDir = path.join(outDir, 'Contract.sol')
      await fs.mkdir(contractDir, { recursive: true })

      const artifactContent = {
        contractName: 'TestContract',
        abi: [{ type: 'function', name: 'test' }],
        bytecode: '0x608060405234801561001057600080fd5b50',
      }

      await fs.writeFile(
        path.join(contractDir, 'Contract.json'),
        JSON.stringify(artifactContent, null, 2)
      )

      // Call the method
      await deploymentService.sendDeploymentStartedNotification(testWorkingDir)

      // Verify buildBearApi was called with compressed artifacts
      const { buildBearApi } = require('../buildBearApi')
      expect(buildBearApi.sendDeploymentNotification).toHaveBeenCalledWith({
        status: 'started',
        config: {
          envs: expect.any(Object),
          artifacts: expect.objectContaining({
            'Contract.sol/Contract.json':
              expect.stringContaining('TestContract'),
          }),
        },
      })
    })

    test('should use profile-specific out directory when FOUNDRY_PROFILE is set', async () => {
      // Set environment variable
      process.env.FOUNDRY_PROFILE = 'ci'

      // Setup foundry.toml
      const foundryToml = `[profile.default]
out = "out"

[profile.ci]
out = "out-ci"`

      await fs.writeFile(path.join(testWorkingDir, 'foundry.toml'), foundryToml)

      // Create CI-specific out directory with artifacts
      const outCiDir = path.join(testWorkingDir, 'out-ci')
      await fs.mkdir(outCiDir, { recursive: true })

      const ciArtifact = { name: 'CIContract', type: 'ci-build' }
      await fs.writeFile(
        path.join(outCiDir, 'ci-artifact.json'),
        JSON.stringify(ciArtifact)
      )

      // Also create default out directory (should not be used)
      const defaultOutDir = path.join(testWorkingDir, 'out')
      await fs.mkdir(defaultOutDir, { recursive: true })
      await fs.writeFile(
        path.join(defaultOutDir, 'default-artifact.json'),
        JSON.stringify({ name: 'DefaultContract' })
      )

      // Call the method
      await deploymentService.sendDeploymentStartedNotification(testWorkingDir)

      // Verify buildBearApi was called with CI artifacts, not default
      const { buildBearApi } = require('../buildBearApi')
      const callArgs = buildBearApi.sendDeploymentNotification.mock.calls[0][0]

      expect(callArgs.config.artifacts).toHaveProperty('ci-artifact.json')
      expect(callArgs.config.artifacts).not.toHaveProperty(
        'default-artifact.json'
      )
      expect(callArgs.config.artifacts['ci-artifact.json']).toContain(
        'CIContract'
      )
    })

    test('should handle empty out directory gracefully', async () => {
      // Create empty out directory
      const outDir = path.join(testWorkingDir, 'out')
      await fs.mkdir(outDir, { recursive: true })

      // Call the method
      await deploymentService.sendDeploymentStartedNotification(testWorkingDir)

      // Verify buildBearApi was called with empty artifacts object
      const { buildBearApi } = require('../buildBearApi')
      expect(buildBearApi.sendDeploymentNotification).toHaveBeenCalledWith({
        status: 'started',
        config: {
          envs: expect.any(Object),
          artifacts: {},
        },
      })
    })

    test('should handle non-existent out directory gracefully', async () => {
      // Don't create any out directory

      // Call the method
      await deploymentService.sendDeploymentStartedNotification(testWorkingDir)

      // Verify buildBearApi was called with empty artifacts object
      const { buildBearApi } = require('../buildBearApi')
      expect(buildBearApi.sendDeploymentNotification).toHaveBeenCalledWith({
        status: 'started',
        config: {
          envs: expect.any(Object),
          artifacts: {},
        },
      })
    })

    test('should include environment variables alongside artifacts', async () => {
      // Set some test environment variables
      process.env.TEST_VAR = 'test_value'
      process.env.BUILD_NUMBER = '123'
      process.env.SECRET_KEY = 'should_be_redacted'

      // Create minimal out directory
      const outDir = path.join(testWorkingDir, 'out')
      await fs.mkdir(outDir, { recursive: true })
      await fs.writeFile(path.join(outDir, 'test.json'), '{"test":true}')

      // Call the method
      await deploymentService.sendDeploymentStartedNotification(testWorkingDir)

      // Verify both envs and artifacts are included
      const { buildBearApi } = require('../buildBearApi')
      const callArgs = buildBearApi.sendDeploymentNotification.mock.calls[0][0]

      expect(callArgs.config).toHaveProperty('envs')
      expect(callArgs.config).toHaveProperty('artifacts')
      expect(callArgs.config.artifacts).toHaveProperty('test.json')

      // Verify environment variables are processed (sensitive ones redacted)
      expect(callArgs.config.envs).toHaveProperty('TEST_VAR', 'test_value')
      expect(callArgs.config.envs).toHaveProperty('BUILD_NUMBER', '123')
      expect(callArgs.config.envs).toHaveProperty('SECRET_KEY', '[REDACTED]')
    })

    test('should handle complex nested artifact structure', async () => {
      // Setup foundry.toml with custom out directory
      const foundryToml = `[profile.default]
out = "artifacts"`

      await fs.writeFile(path.join(testWorkingDir, 'foundry.toml'), foundryToml)

      // Create complex nested structure
      const artifactsDir = path.join(testWorkingDir, 'artifacts')
      await fs.mkdir(artifactsDir, { recursive: true })

      const contractsDir = path.join(artifactsDir, 'contracts')
      const tokensDir = path.join(contractsDir, 'tokens')
      const interfacesDir = path.join(contractsDir, 'interfaces')

      await fs.mkdir(tokensDir, { recursive: true })
      await fs.mkdir(interfacesDir, { recursive: true })

      // Create various artifacts
      await fs.writeFile(
        path.join(tokensDir, 'ERC20.json'),
        JSON.stringify({ name: 'ERC20Token', type: 'token' })
      )
      await fs.writeFile(
        path.join(interfacesDir, 'IERC20.json'),
        JSON.stringify({ name: 'IERC20', type: 'interface' })
      )
      await fs.writeFile(
        path.join(contractsDir, 'Factory.json'),
        JSON.stringify({ name: 'TokenFactory', type: 'factory' })
      )

      // Call the method
      await deploymentService.sendDeploymentStartedNotification(testWorkingDir)

      // Verify all nested artifacts are included
      const { buildBearApi } = require('../buildBearApi')
      const callArgs = buildBearApi.sendDeploymentNotification.mock.calls[0][0]

      expect(callArgs.config.artifacts).toHaveProperty(
        'contracts/tokens/ERC20.json'
      )
      expect(callArgs.config.artifacts).toHaveProperty(
        'contracts/interfaces/IERC20.json'
      )
      expect(callArgs.config.artifacts).toHaveProperty('contracts/Factory.json')

      expect(
        callArgs.config.artifacts['contracts/tokens/ERC20.json']
      ).toContain('ERC20Token')
      expect(
        callArgs.config.artifacts['contracts/interfaces/IERC20.json']
      ).toContain('IERC20')
      expect(callArgs.config.artifacts['contracts/Factory.json']).toContain(
        'TokenFactory'
      )
    })

    test('should handle API call failure gracefully', async () => {
      // Mock API to throw error
      const { buildBearApi } = require('../buildBearApi')
      buildBearApi.sendDeploymentNotification.mockRejectedValueOnce(
        new Error('API connection failed')
      )

      // Create simple out directory
      const outDir = path.join(testWorkingDir, 'out')
      await fs.mkdir(outDir, { recursive: true })

      // Call the method and expect it to throw
      await expect(
        deploymentService.sendDeploymentStartedNotification(testWorkingDir)
      ).rejects.toThrow('API connection failed')
    })

    test('should respect foundry.toml profile precedence', async () => {
      // Set profile that doesn't exist, should fallback to default
      process.env.FOUNDRY_PROFILE = 'nonexistent'

      const foundryToml = `[profile.default]
out = "fallback-out"`

      await fs.writeFile(path.join(testWorkingDir, 'foundry.toml'), foundryToml)

      // Create fallback directory
      const fallbackDir = path.join(testWorkingDir, 'fallback-out')
      await fs.mkdir(fallbackDir, { recursive: true })
      await fs.writeFile(
        path.join(fallbackDir, 'fallback.json'),
        JSON.stringify({ fallback: true })
      )

      // Call the method
      await deploymentService.sendDeploymentStartedNotification(testWorkingDir)

      // Verify fallback artifacts are used
      const { buildBearApi } = require('../buildBearApi')
      const callArgs = buildBearApi.sendDeploymentNotification.mock.calls[0][0]

      expect(callArgs.config.artifacts).toHaveProperty('fallback.json')
      expect(callArgs.config.artifacts['fallback.json']).toContain('fallback')
    })
  })

  describe('Integration with existing deployment pipeline', () => {
    test('should work with executeDeploymentPipeline when no networks provided', async () => {
      // Create artifacts
      const outDir = path.join(testWorkingDir, 'out')
      await fs.mkdir(outDir, { recursive: true })
      await fs.writeFile(
        path.join(outDir, 'pipeline.json'),
        JSON.stringify({ pipeline: 'test' })
      )

      // Execute pipeline with no networks (artifacts only)
      const result = await deploymentService.executeDeploymentPipeline({
        networks: [],
        workingDirectory: testWorkingDir,
      })

      // Verify deployment started notification was called
      const { buildBearApi } = require('../buildBearApi')
      expect(buildBearApi.sendDeploymentNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'started',
          config: expect.objectContaining({
            artifacts: expect.objectContaining({
              'pipeline.json': expect.stringContaining('pipeline'),
            }),
          }),
        })
      )

      expect(result).toEqual([])
    })

    test('should maintain backward compatibility with existing notification structure', async () => {
      // Create artifacts
      const outDir = path.join(testWorkingDir, 'out')
      await fs.mkdir(outDir, { recursive: true })
      await fs.writeFile(
        path.join(outDir, 'compat.json'),
        JSON.stringify({ compatibility: 'test' })
      )

      // Call notification
      await deploymentService.sendDeploymentStartedNotification(testWorkingDir)

      // Verify the notification structure matches expected format
      const { buildBearApi } = require('../buildBearApi')
      const callArgs = buildBearApi.sendDeploymentNotification.mock.calls[0][0]

      expect(callArgs).toHaveProperty('status', 'started')
      expect(callArgs).toHaveProperty('config')
      expect(callArgs.config).toHaveProperty('envs')
      expect(callArgs.config).toHaveProperty('artifacts')
      expect(typeof callArgs.config.envs).toBe('object')
      expect(typeof callArgs.config.artifacts).toBe('object')
    })
  })
})
