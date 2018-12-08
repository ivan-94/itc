import { Transport, Peer, MesssagePayload, Disposer, Worker, Storage } from './transport'

let instance: Transport

export { Transport, Peer, Disposer, Worker, MesssagePayload }

export default function create(name: string, options: {} = {}): Transport {
  if (instance && !instance.destroyed) {
    return instance
  }

  return (instance = new Storage(name) as Transport)
  // return (instance = new Worker(options.url) as Transport)
}
