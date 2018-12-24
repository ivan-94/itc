import { Transport, Peer, MessagePayload, Disposer, Worker, Storage } from './transport'

let instance: Transport

export { Transport, Peer, Disposer, Worker, MessagePayload }

const defaultOptions = {
  useStorage: false,
}

export default function create(
  name: string,
  options?: {
    useStorage?: boolean
    url?: string
  },
): Transport {
  options = { ...defaultOptions, ...(options || {}) }
  if (instance && !instance.destroyed) {
    return instance
  }

  return (instance = (options.useStorage || !Worker.isSupport
    ? new Storage(name)
    : new Worker(name, options.url)) as Transport)
}
