function getAllEnvironmentVariables() {
  const envObject = {}

  Object.keys(process.env).forEach((key) => {
    envObject[key] = process.env[key]
  })

  return envObject
}

module.exports = { getAllEnvironmentVariables }
