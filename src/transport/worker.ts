/**
 * 利用SharedWorker进行多页面通信
 * TODO: 健壮错误处理
 */
import EventEmitter from './event-emitter'
import { hash } from '../utils'
import { Transport, MessagePayload, Peer, EVENTS } from './transport'
import workerSource, { ItcWorker } from './worker-script'

declare global {
  interface Window {
    SharedWorker: SharedWorker.SharedWorker
  }
}

export interface WorkerPayload extends MessagePayload {
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

const WorkerPeer = {
  id: -1,
  name: 'worker',
}

export const MAX_TRY_TIME = 4

export default class WorkerTransport extends EventEmitter implements Transport {
  static isSupport = !!(window.btoa && window.SharedWorker)
  private tryTimes: number = 0
  private currentMaster?: Peer
  private peers: Peer[] = []
  private worker?: SharedWorker.SharedWorker
  private url?: string

  constructor(name: string, url?: string) {
    super(name)
    this.url = url
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
      this.postMessage(WorkerPeer, { type: EVENTS.DESTROY })
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
      this.worker = new SharedWorker(this.url ? this.url : this.genSource())
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

  protected postMessage(peer: Peer, data: MessagePayload) {
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

export { workerSource, ItcWorker }
