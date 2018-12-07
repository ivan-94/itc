const { execSync } = require('child_process')

execSync(`rm -rf dist`, { stdio: 'inherit' })
execSync(`tsc`, { stdio: 'inherit' })
