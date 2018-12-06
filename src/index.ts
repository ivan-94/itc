import { Transport, Peer, MesssagePayload, Disposer, Worker } from './transport'

let instance: Transport

export { Transport, Peer, Disposer, Worker }

export default function create(options: { url?: string } = {}): Transport {
  if (instance && !instance.destroyed) {
    return instance
  }

  return (instance = new Worker(options.url) as Transport)
}
