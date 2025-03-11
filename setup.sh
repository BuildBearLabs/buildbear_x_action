#!/bin/bash

echo "🚀 Setting up the project..."

# Exit on error
set -e

# Check for Node.js & npm
if ! command -v node &>/dev/null; then
    echo "❌ Node.js is not installed. Please install it first: https://nodejs.org/"
    exit 1
fi

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Ensure Husky is installed
if [ ! -d ".husky" ]; then
    echo "🔧 Setting up Husky..."
    npx husky-init && rm .husky/pre-commit
fi

# Create pre-commit hook
echo "✍️ Adding pre-commit hook..."
cat <<EOT > .husky/pre-commit
#!/bin/sh
npm run precommit
EOT

# Make hook executable
chmod +x .husky/pre-commit

# Ensure package.json has Husky prepare script
echo "🔄 Ensuring Husky prepare script exists..."
jq '.scripts.prepare = "husky install"' package.json > temp.json && mv temp.json package.json

# Commit setup
git add package.json .husky/pre-commit
git commit -m "chore: setup Husky and pre-commit hooks" --no-verify

echo "✅ Project setup complete! Run 'git commit' to test the pre-commit hook."
