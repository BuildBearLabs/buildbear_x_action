# BB Action CI

This GitHub Action allows you to automate smart contract deployments across multiple networks using BuildBear's infrastructure. With a setup, you can deploy contracts on the specified networks, making it easier to manage multi-network deployments in your CI/CD pipeline.

## ⚠️ Important: BuildBear Foundry Fork

This action requires using BuildBear's fork of Foundry, which includes essential updates for:
- Generating enhanced artifacts for test simulation
- Enabling automatic contract verification
- Improved integration with BuildBear's infrastructure

Install our Foundry fork instead of the standard version:
```bash
curl -L https://github.com/BuildBearLabs/foundry/releases/latest/download/foundry_nightly_linux_amd64.tar.gz | tar xzf - -C ~/.foundry/bin/
```

## 📋 Features

- Uses BuildBear's enhanced Foundry fork for improved testing and verification
- Deploys smart contracts on specified networks
- Integrates seamlessly with the BuildBear platform
- Supports custom deployment commands and network specifications
- Enables automatic contract verification
- Provides test simulation capabilities through BuildBear's backend

## 🛠️ Inputs

| Name               | Description                                                                                              | Required |
| ------------------ | -------------------------------------------------------------------------------------------------------- | -------- |
| `network`          | List of networks to deploy on, with `chainId` and optional `blockNumber`. Example format provided below. | `true`   |
| `deploy-command`   | Command to deploy the contract, such as `make deploy`.                                                   | `true`   |
| `buildbear-token`  | Your BuildBear API token for authentication.                                                             | `true`   |
| `working-directory`| Path to the directory containing the project. Default is the root directory.                             | `false`  |

### Example `network` Input Format

The `network` input is expected as a JSON array containing network details, each with `chainId` and optionally a `blockNumber`:

```json
[
  {
    "chainId": 1,
    "blockNumber": 12000000 // Optional
  },
  {
    "chainId": 10
  }
]
```

## 🌐 Runtime Environment Variables  

During the execution of this action, the following environment variables are available:

- **`BUILDBEAR_RPC_URL`**: The RPC URL provided by BuildBear, enabling connections to the sandbox.  
- **`MNEMONIC`**: A 12- or 24-word mnemonic phrase used for signing transactions during deployment.  

## 📤 Outputs

| Name          | Description              |
| ------------- | ------------------------ |
| `deployments` | Logs from deployments.   |

## 🚀 Usage Example

In your GitHub workflow file, you can set up this action as follows:

```yaml
name: deploy to BuildBear Sandbox

on: [push]

jobs:
  test:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          submodules: recursive

      - name: Install BuildBear's Foundry Fork
        run: |
          curl -L https://raw.githubusercontent.com/BuildBearLabs/foundry/master/foundryup/install | bash
          foundryup
        shell: bash

      - name: Show Forge version
        run: forge --version

      - name: Run Forge Tests (Optional)
        run: forge test -vvv

      - name: Run BB Action CI
        uses: BuildBearLabs/buildbear_x_action@v1.0.0
        with:
          network: |
            [
              {
                "chainId": 1,
                "blockNumber": 12000000 // Optional block number
              },
              {
                "chainId": 10
              }
            ]
          deploy-command: "make deploy"
          buildbear-token: "${{ secrets.BUILDBEAR_TOKEN }}"
```

> **Note:** 
> 1. Make sure to use BuildBear's Foundry fork instead of the standard Foundry installation
> 2. Ensure that the `buildbear-token` is securely stored as a secret in your GitHub repository under `BUILDBEAR_TOKEN`

## 📚 Tutorial

1. **Set up GitHub Secrets**: Add your BuildBear API token as a secret in your repository settings.
2. **Define Networks**: In the `network` input, specify the networks and optional block numbers for deployment.
3. **Add Deployment Command**: Define the deployment command under `deploy-command`.
4. **Run Workflow**: Trigger the workflow on push or any specified event to deploy contracts on the selected networks.

## 📘 Additional Notes

- Ensure the `deploy-command` matches the command in your project for deploying contracts.
- This action requires Node.js 20 (`node20`) to run the main deployment script.
- Running forge tests is optional and can be skipped if you don't need to run tests as part of your workflow.
