const fs = require('fs')
const { execSync } = require('child_process')

execSync(`rm -rf dist`, {
  stdio: 'inherit',
})
execSync(`tsc --build tsconfig.build.json`, {
  stdio: 'inherit',
})

// generate standalone worker script
function generateWorkerSource() {
  const prettier = require('prettier')
  const workerSource = require('./dist/transport/worker-script').default
  const events = require('./dist/transport/transport').EVENTS
  const source = `
    (function(window) {
      (${workerSource.toString()})(${JSON.stringify(events)}, window);
    })(this)
  `

  fs.writeFileSync(
    'worker-script.js',
    prettier.format(source, {
      semi: true,
      parser: 'babylon',
    }),
  )
}

generateWorkerSource()
