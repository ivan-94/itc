// flush all promise

const setTimeout = global.setTimeout
export function delay() {
  return new Promise(res => {
    setTimeout(() => {
      res()
    }, 0)
  })
}
