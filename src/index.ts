import { Transport, Peer, MesssagePayload, Disposer, Worker, Storage } from './transport'

let instance: Transport

export { Transport, Peer, Disposer, Worker, MesssagePayload }

const defaultOptions = {
  useStorage: false,
}

export default function create(
  name: string,
  options?: {
    useStorage?: boolean
  },
): Transport {
  options = { ...defaultOptions, ...(options || {}) }
  if (instance && !instance.destroyed) {
    return instance
  }

  return (instance = (options.useStorage || !Worker.isSupport ? new Storage(name) : new Worker(name)) as Transport)
}
