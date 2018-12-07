export function hash(str: string) {
  let hash = 0
  if (str.length) {
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i)
      hash |= 0
    }
  }

  return hash.toString(36)
}

function s4() {
  return Math.floor(Math.random() * 0x10000 /* 65536 */).toString(16)
}

/**
 * UUID — http://ru.wikipedia.org/wiki/UUID
 */
export function uuid() {
  return s4() + s4() + '-' + s4() + '-' + s4() + '-' + s4() + '-' + s4() + s4() + s4()
}

export function delay(time: number = 0) {
  return new Promise(res => setTimeout(res, time))
}

export function getRandomIntInclusive(min: number, max: number) {
  min = Math.ceil(min)
  max = Math.floor(max)
  return Math.floor(Math.random() * (max - min + 1)) + min
}

export function objEquals<T extends object>(a: T, b: T, ...args: string[]) {
  for (let key in a) {
    if (a.hasOwnProperty(key)) {
      if (args.indexOf(key) !== -1) {
        continue
      }

      if (a[key] !== b[key]) {
        return false
      }
    }
  }
  return true
}
