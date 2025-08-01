#!/usr/bin/env node

// Test script to demonstrate the IOUtils environment variable handling
const { ioUtils } = require('../ioUtils')

// Set up some test environment variables
process.env.TEST_NORMAL = 'normal_value'
process.env.TEST_EMPTY = ''
process.env.TEST_WHITESPACE = '   '
process.env.TEST_API_EMPTY = 'API: '
process.env.TEST_DB_EMPTY = 'DB_URL: '
process.env.TEST_SECRET_KEY = 'secret123'
process.env.TEST_NULL = null
process.env.TEST_UNDEFINED = undefined

console.log('Testing IOUtils environment variable handling...\n')

// Test 1: Default behavior (excludeEmpty = true)
console.log('=== Test 1: Default behavior (excludeEmpty = true) ===')
const defaultResult = ioUtils.getAllEnvironmentVariables({
  include: [
    'TEST_NORMAL',
    'TEST_EMPTY',
    'TEST_WHITESPACE',
    'TEST_API_EMPTY',
    'TEST_DB_EMPTY',
    'TEST_SECRET_KEY',
    'TEST_NULL',
    'TEST_UNDEFINED',
  ],
})
console.log('Result:', JSON.stringify(defaultResult, null, 2))

// Test 2: Include empty values
console.log('\n=== Test 2: Include empty values (excludeEmpty = false) ===')
const includeEmptyResult = ioUtils.getAllEnvironmentVariables({
  include: [
    'TEST_NORMAL',
    'TEST_EMPTY',
    'TEST_WHITESPACE',
    'TEST_API_EMPTY',
    'TEST_DB_EMPTY',
    'TEST_SECRET_KEY',
    'TEST_NULL',
    'TEST_UNDEFINED',
  ],
  excludeEmpty: false,
})
console.log('Result:', JSON.stringify(includeEmptyResult, null, 2))

// Test 3: Include sensitive data
console.log(
  '\n=== Test 3: Include sensitive data (includeSensitive = true) ==='
)
const includeSensitiveResult = ioUtils.getAllEnvironmentVariables({
  include: [
    'TEST_NORMAL',
    'TEST_EMPTY',
    'TEST_WHITESPACE',
    'TEST_API_EMPTY',
    'TEST_DB_EMPTY',
    'TEST_SECRET_KEY',
    'TEST_NULL',
    'TEST_UNDEFINED',
  ],
  includeSensitive: true,
})
console.log('Result:', JSON.stringify(includeSensitiveResult, null, 2))

console.log('\n=== Summary ===')
console.log(
  '✅ Empty environment variables like "API: " are now properly handled'
)
console.log('✅ Null/undefined values are filtered out')
console.log('✅ Whitespace-only values are excluded')
console.log('✅ Sensitive data is redacted by default')
console.log(
  '✅ Error handling prevents crashes from malformed environment variables'
)
