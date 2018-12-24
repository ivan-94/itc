import { EVENTS, MessagePayload, Peer } from './transport'
import { ExtendedPort, WorkerPayload, InitializeState, PeerInitialState } from './worker'

export interface ItcWorker {
  ports: ExtendedPort[]
  master: ExtendedPort | undefined
  scope: SharedWorker.SharedWorkerGlobalScope
  uid: number
  checkMaster(): void
  removePort(port: ExtendedPort): void
  getPeers(port: ExtendedPort): Peer[]
  updatePeer(currentPort?: ExtendedPort): void
  broadcast(data: MessagePayload, source?: ExtendedPort): void
  postMessage(data: WorkerPayload, source?: ExtendedPort): void
}

/**
 * worker 源代码
 */
export default function workerSource(events: typeof EVENTS, scope: SharedWorker.SharedWorkerGlobalScope): ItcWorker {
  class ItcWorkerImpl implements ItcWorker {
    ports: ExtendedPort[] = []
    master: ExtendedPort | undefined
    scope: SharedWorker.SharedWorkerGlobalScope
    uid: number = 0

    checkMaster() {
      if (this.master == null && this.ports.length) {
        this.master = this.ports[0]
        this.master.postMessage({ type: events.BECOME_MASTER })
        this.broadcast({ type: events.UPDATE_MASTER, data: { id: this.master.id, name: this.master.name } })
      }
    }

    removePort(port: ExtendedPort) {
      const index = this.ports.indexOf(port)
      if (index !== -1) {
        this.ports.splice(index, 1)
      }

      if (this.master === port) {
        this.master = undefined
      }

      this.updatePeer()
      this.checkMaster()
    }

    getPeers(port: ExtendedPort) {
      return this.ports.filter(p => p.id !== port.id).map(p => ({ id: p.id, name: p.name }))
    }

    /**
     * sync peers
     */
    updatePeer(currentPort?: ExtendedPort) {
      this.ports
        .filter(p => p !== currentPort)
        .forEach(port => {
          const peers = this.getPeers(port)
          port.postMessage({ type: events.UPDATE_PEERS, data: peers })
        })
    }

    broadcast(data: MessagePayload, source?: ExtendedPort) {
      this.ports.filter(p => p !== source).forEach(port => port.postMessage(data))
    }

    postMessage(data: WorkerPayload, source?: ExtendedPort) {
      if (data.target == null || data.target === '*') {
        this.broadcast(data, source)
        return
      }

      if (data.target === -1) {
        return
      }

      const idx = this.ports.findIndex(i => i.id === data.target)
      if (idx !== -1) {
        this.ports[idx].postMessage(data)
      }
    }

    heartbeat() {
      setTimeout(() => {
        let i = this.ports.length
        while (i--) {
          const port = this.ports[i]
          if (port.zoombie) {
            this.removePort(port)
          } else {
            port.zoombie = true
            port.postMessage({ type: events.PING })
          }
        }
        this.heartbeat()
      }, 500)
    }

    constructor(scope: SharedWorker.SharedWorkerGlobalScope) {
      this.scope = scope
      this.listen()
      this.heartbeat()
    }

    listen() {
      this.scope.addEventListener('connect', (event: Event) => {
        const port = (event as MessageEvent).ports[0] as ExtendedPort
        port.id = this.uid++

        port.addEventListener('message', (evt: MessageEvent) => {
          // reconnect
          if (this.ports.indexOf(port) === -1) {
            this.ports.push(port)
            this.checkMaster()
            this.updatePeer()
            // force update master
            this.postMessage({
              target: port.id,
              type: events.UPDATE_MASTER,
              data: { id: this.master!.id, name: this.master!.name },
            } as WorkerPayload)
          }

          const message = evt.data as WorkerPayload
          switch (message.type) {
            case events.PONG:
              port.zoombie = false
              break
            case events.MESSAGE:
              // forward to other ports
              this.postMessage(message, port)
              break
            case events.DESTROY:
              this.removePort(port)
              break
            case events.INITIAL:
              const { name } = message.data as PeerInitialState
              port.name = name
              this.updatePeer(port)
              break
            default:
              // forward to other ports
              this.postMessage(message, port)
              break
          }
        })

        this.ports.push(port)
        port.start()
        const currentMaster = this.master || port
        const initialState: InitializeState = {
          id: port.id,
          peers: this.getPeers(port),
          master: { name: currentMaster.name, id: currentMaster.id },
        }
        port.postMessage({
          type: events.CONNECTED,
          data: initialState,
        })
        this.checkMaster()
      })
    }
  }

  return new ItcWorkerImpl(scope)
}
