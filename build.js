const fs = require('fs')
const { execSync } = require('child_process')

function genSource() {
  const source = require('./dist/transport/worker-source')
  const events = require('./dist/transport/transport')

  const content = `(${source.default.toString()})(${JSON.stringify(events.EVENTS)})`
  return content
}

execSync(`rm -rf dist`, { stdio: 'inherit' })
execSync(`tsc`, { stdio: 'inherit' })
fs.writeFileSync('./worker-script.js', genSource())
