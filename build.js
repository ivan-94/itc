const { execSync } = require('child_process')

execSync(`rm -rf dist`, { stdio: 'inherit' })
execSync(`tsc --build tsconfig.build.json`, { stdio: 'inherit' })
