/**
 * 利用SharedWorker进行多页面通信
 * TODO: 健壮错误处理
 */
import EventEmitter from './event-emitter'
import { hash } from '../utils'
import { Transport, MesssagePayload, Peer, EVENTS } from './transport'

export interface WorkerPayload extends MesssagePayload {
  target: string | number
  source: Peer
}

export interface InitializeState {
  id: number
  peers: Peer[]
  master: Peer
}

export interface PeerInitialState {
  name: string
}

export type ExtendedPort = MessagePort & { zoombie: boolean; id: number; name: string }

export interface ItcWorker {
  ports: ExtendedPort[]
  master: ExtendedPort | undefined
  scope: SharedWorker.SharedWorkerGlobalScope
  uid: number
  checkMaster(): void
  removePort(port: ExtendedPort): void
  getPeers(port: ExtendedPort): Peer[]
  updatePeer(currentPort?: ExtendedPort): void
  broadcast(data: MesssagePayload, source?: ExtendedPort): void
  postMessage(data: WorkerPayload, source?: ExtendedPort): void
}

const WorkerPeer = {
  id: -1,
  name: 'worker',
}

export const MAX_TRY_TIME = 4

export default class WorkerTransport extends EventEmitter implements Transport {
  static isSupport = !!(btoa && SharedWorker)
  id: number = 0
  private tryTimes: number = 0
  private currentMaster?: Peer
  private peers: Peer[] = []
  private worker?: SharedWorker.SharedWorker

  private get current() {
    return {
      id: this.id,
      name: this.name,
    }
  }

  constructor(name: string) {
    super(name)
    this.initializeWorker()
    window.addEventListener('unload', this.destroy)
  }

  getPeers() {
    this.checkWorkerAvailable()
    return this.waitReady().then(() => this.peers)
  }

  getMaster() {
    this.checkWorkerAvailable()
    return this.waitReady().then(() => this.currentMaster)
  }

  isMaster() {
    return this.getMaster().then(master => {
      return !!master && master.id === this.id
    })
  }

  destroy = () => {
    if (this.destroyed) {
      return
    }

    window.removeEventListener('unload', this.destroy)

    if (this.worker) {
      this.worker.port.removeEventListener('message', this.onMessage)
      this.postMessage(WorkerPeer, { type: EVENTS.DESTORY })
      this.worker = undefined
    }

    this.emit('destroy')
  }

  private initializeWorker = () => {
    if (this.tryTimes >= MAX_TRY_TIME) {
      return
    }

    this.tryTimes++

    try {
      this.worker = new SharedWorker(this.genSource())
    } catch (err) {
      console.warn('[itc] SharedWorker Error: ', err)
      this.initializeWorker()
      return
    }

    this.worker.addEventListener('error', this.handleWorkerError)
    this.worker.port.addEventListener('message', this.onMessage)
    this.worker.port.start()
  }

  private handleWorkerError = (evt: Event) => {
    const { filename, lineno, colno, message } = evt as ErrorEvent
    console.warn(`[itc] SharedWorker Error in ${filename}(${lineno}:${colno}): ${message}`)
    if (this.worker) {
      this.worker.port.removeEventListener('message', this.onMessage)
      this.worker.removeEventListener('error', this.handleWorkerError)
      this.worker = undefined
    }
    this.initializeWorker()
  }

  private onMessage = (evt: MessageEvent) => {
    const message = evt.data as WorkerPayload
    const { target, source, type, data } = message

    if (source && source.id === this.id) {
      return
    }

    switch (type) {
      case EVENTS.PING:
        this.postMessage(WorkerPeer, { type: EVENTS.PONG })
        break
      case EVENTS.BECOME_MASTER:
        this.emit('master')
        console.log('master')
        break
      case EVENTS.CONNECTED:
        const { id, peers, master } = data as InitializeState
        const initialState: PeerInitialState = {
          name: this.name,
        }
        this.id = id
        this.peers = peers
        this.currentMaster = master
        this.postMessage(WorkerPeer, { type: EVENTS.INITIAL, data: initialState })
        this.emit('ready')
        console.log('ready')
        break
      case EVENTS.MESSAGE:
        this.emit('message', data)
        break
      case EVENTS.CALL:
        this.responseInternal(source, data)
        break
      case EVENTS.CALL_RESPONSE:
        this.callReturn(source, data)
        break
      case EVENTS.UPDATE_PEERS:
        this.peers = data
        this.emit('peerupdate', this.peers)
        console.log('peer update')
        break
      case EVENTS.UPDATE_MASTER:
        const prevMaster = this.currentMaster
        this.currentMaster = data
        if (prevMaster && prevMaster.id === this.id && prevMaster.id !== this.currentMaster!.id) {
          console.log('master lose')
          this.emit('masterlose')
        }
        this.emit('masterupdate', this.currentMaster)
        console.log('master update')
        break
      default:
        console.warn(`[itc] unknown events: ${type}`)
        break
    }
  }

  protected postMessage(peer: Peer, data: MesssagePayload) {
    if (this.destroyed) {
      return
    }

    if (peer.id === this.id) {
      console.warn('[itc] cannot postMessage to self')
      return
    }

    const payload: WorkerPayload = {
      target: peer.id,
      source: this.current,
      ...data,
    }
    this.worker!.port.postMessage(payload)
  }

  private genSource() {
    const source = this.getSource()
    const sourceHash = hash(source)
    const key = `itc-sw-${sourceHash}`
    let cachedUrl = window.localStorage.getItem(key)
    if (cachedUrl) {
      return cachedUrl
    } else {
      const cachedUrl = `data:text/javascript;base64,${btoa(source)}`
      window.localStorage.setItem(key, cachedUrl)
      return cachedUrl
    }
  }

  private getSource() {
    return `
    (function(window){
      (${workerSource.toString()})(${JSON.stringify(EVENTS)}, window);
    })(this)
    `
  }
}

/**
 * worker 源代码
 */
export function workerSource(events: typeof EVENTS, scope: SharedWorker.SharedWorkerGlobalScope): ItcWorker {
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

    broadcast(data: MesssagePayload, source?: ExtendedPort) {
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
            case events.DESTORY:
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
