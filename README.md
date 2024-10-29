# BB Action CI

This GitHub Action allows you to automate smart contract deployments across multiple networks using BuildBear’s infrastructure. With a setup, you can deploy contracts on the specified networks, making it easier to manage multi-network deployments in your CI/CD pipeline.

## 📋 Features

- Deploys smart contracts on specified networks.
- Integrates seamlessly with the BuildBear platform.
- Supports custom deployment commands and network specifications.

## 🛠️ Inputs

| Name             | Description                        | Required |
| ---------------- | ---------------------------------- | -------- |
| `network`        | List of networks to deploy on, with `chainId` and optional `blockNumber`. Example format provided below. | `true`   |
| `deployCmd`      | Command to deploy the contract, such as `make deploy`. | `true`   |
| `buildbear_token`| Your BuildBear API token for authentication. | `true`   |

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

## 📤 Outputs

| Name          | Description              |
| ------------- | ------------------------ |
| `deployments` | Logs from deployments.   |

## 🚀 Usage Example

In your GitHub workflow file, you can set up this action as follows:

```yaml
name: Test My Action

on: [push]

jobs:
  test:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          submodules: recursive

      - name: Install Foundry
        uses: foundry-rs/foundry-toolchain@v1
        with:
          version: nightly

      - name: Show Forge version
        run: forge --version

      - name: Run BB Action CI
        uses: arjunbuildbear/test2@30
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
          deployCmd: "make deploy"
          buildbear_token: "${{ secrets.BUILDBEAR_TOKEN }}"
```

> **Note:** Ensure that the `buildbear_token` is securely stored as a secret in your GitHub repository under `BUILDBEAR_TOKEN`.

## 📚 Tutorial

1. **Set up GitHub Secrets**: Add your BuildBear API token as a secret in your repository settings.
2. **Define Networks**: In the `network` input, specify the networks and optional block numbers for deployment.
3. **Add Deployment Command**: Define the deployment command under `deployCmd`.
4. **Run Workflow**: Trigger the workflow on push or any specified event to deploy contracts on the selected networks.

## 📘 Additional Notes

- Ensure the `deployCmd` matches the command in your project for deploying contracts.
- This action requires Node.js 20 (`node20`) to run the main deployment script. 
