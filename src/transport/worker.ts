/**
 * 利用SharedWorker进行多页面通信
 * TODO: 健壮错误处理
 */
import EventEmitter from './event-emitter'
import { hash } from '../utils'
import { Transport, MesssagePayload, Peer, EVENTS } from './transport'

interface WorkerPayload extends MesssagePayload {
  target: string | number
  source: Peer
}

interface InitializeState {
  id: number
  peers: Peer[]
  master: Peer
}

interface PeerInitialState {
  name: string
}

const WorkerPeer = {
  id: -1,
  name: 'worker',
}

const MAX_TRY_TIME = 4

export default class WorkerTransport extends EventEmitter implements Transport {
  private tryTimes: number = 0
  private id: number = 0
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
    this.emit('destroy')

    if (this.worker) {
      this.worker.port.removeEventListener('message', this.onMessage)
      this.postMessage(WorkerPeer, { type: EVENTS.DESTORY })
      this.worker = undefined
    }
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
      delete this.worker!.onerror
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
        this.callReturn(source, data.data)
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
    if (peer.id === this.id) {
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
    const source = `(${workerSource.toString()})(${JSON.stringify(EVENTS)})`
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
}

/**
 * worker 源代码
 */
export function workerSource(this: SharedWorker.SharedWorkerGlobalScope, events: typeof EVENTS) {
  type ExtendedPort = MessagePort & { zoombie: boolean; id: number; name: string }
  const ports: ExtendedPort[] = []
  let master: ExtendedPort | undefined
  let uid: number = 0

  function checkMaster() {
    if (master == null && ports.length) {
      master = ports[0]
      master.postMessage({ type: events.BECOME_MASTER })
      broadcast({ type: events.UPDATE_MASTER, data: { id: master.id, name: master.name } })
    }
  }

  function removePort(port: ExtendedPort) {
    const index = ports.indexOf(port)
    if (index !== -1) {
      ports.splice(index, 1)
    }

    if (master === port) {
      master = undefined
    }

    updatePeer()
    checkMaster()
  }

  /**
   * sync peers
   */
  function updatePeer() {
    ports.forEach(port => {
      const peers = getPeers(port)
      port.postMessage({ type: events.UPDATE_PEERS, data: peers })
    })
  }

  function getPeers(port: ExtendedPort) {
    return ports.filter(p => p.id !== port.id).map(p => ({ id: p.id, name: p.name }))
  }

  function broadcast(data: MesssagePayload) {
    ports.forEach(port => port.postMessage(data))
  }

  function postMessage(data: WorkerPayload) {
    if (data.target == null || data.target === '*') {
      broadcast(data)
      return
    }

    if (data.target === -1) {
      return
    }

    const idx = ports.findIndex(i => i.id === data.target)
    if (idx !== -1) {
      ports[idx].postMessage(data)
    }
  }

  function heartbeat() {
    setTimeout(() => {
      let i = ports.length
      while (i--) {
        const port = ports[i]
        if (port.zoombie) {
          removePort(port)
        } else {
          port.zoombie = true
          port.postMessage({ type: events.PING })
        }
      }
      heartbeat()
    }, 500)
  }

  this.addEventListener('connect', function(event: Event) {
    const port = (event as MessageEvent).ports[0] as ExtendedPort
    port.id = uid++

    port.addEventListener('message', function(evt: MessageEvent) {
      // reconnect
      if (ports.indexOf(port) === -1) {
        ports.push(port)
        checkMaster()
        updatePeer()
        // force update master
        postMessage({
          target: port.id,
          type: events.UPDATE_MASTER,
          data: { id: master!.id, name: master!.name },
        } as WorkerPayload)
      }

      const message = evt.data as WorkerPayload
      switch (message.type) {
        case events.PONG:
          port.zoombie = false
          break
        case events.MESSAGE:
          // forward to other ports
          postMessage(message)
          break
        case events.DESTORY:
          removePort(port)
          break
        case events.INITIAL:
          const { name } = message.data as PeerInitialState
          port.name = name
          updatePeer()
          break
        default:
          // forward to other ports
          postMessage(message)
          break
      }
    })

    ports.push(port)
    port.start()
    const currentMaster = master || port
    const initialState: InitializeState = {
      id: port.id,
      peers: getPeers(port),
      master: { name: currentMaster.name, id: currentMaster.id },
    }
    port.postMessage({
      type: events.CONNECTED,
      data: initialState,
    })
    checkMaster()
  })

  heartbeat()
}
