import * as utils from '../utils'

test('objEquals', () => {
  expect(utils.objEquals({ a: 1, b: 2, c: 3 }, { a: 1, b: 2, c: 4 })).toBeFalsy()
  expect(utils.objEquals({ a: 1, b: 2, c: 3 }, { a: 1, b: 2, c: 3 }, 'c')).toBeTruthy()
  expect(utils.objEquals({ b: 2, a: 1, c: 3 }, { a: 1, b: 2, c: 3 }, 'c')).toBeTruthy()
})

test('getRandomIntInclusive', () => {
  for (let i = 0; i < 100; i++) {
    const value = utils.getRandomIntInclusive(10, 100)
    expect(value).toBeGreaterThanOrEqual(10)
    expect(value).toBeLessThanOrEqual(100)
  }
})
