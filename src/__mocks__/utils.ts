const actualModule = require.requireActual('../utils')

module.exports = actualModule

jest.spyOn(actualModule, 'uuid').mockImplementation(() => {
  return '1'
})

jest.spyOn(actualModule, 'delay').mockImplementation(() => Promise.resolve())

jest.spyOn(actualModule, 'getRandomIntInclusive').mockImplementation(() => 2)
