/**
 * 利用storage event 多个同域页面实例之间进行通信
 *
 * 每个tab开启后会检查当前是有存在master tab. 和SharedWorker一样, master tab作为一个
 * 中间消息中转者, 用于转发和管理peer. 和SharedWorker不一样的是, master tab可能会被销毁,
 * 当slave tab和master tab的心跳中止后会认为master已经销毁. 这时候slave tab会去抢占master tab的
 * 地位. 这里也要考虑master假死的状况(比如页面被调试阻塞), 当master假死恢复后, 就丧失master的地位了.
 *
 * ## key 规范
 * NAMESPACE.event.desc
 * 内置events有
 *   + NS_master 表示当前的master, 所有tabs都向它发送消息
 *   + NS_message 用于消息传递
 * ## message 载荷规范
 * + target: id, 接收者id, 非接收者应该忽略掉. *表示广播
 * + data: 消息类型, 包含type(事件名), data(事件载荷)
 * + source: 消息源
 *
 */
import { uuid, delay, getRandomIntInclusive, objEquals } from '../utils'

import { Transport, Peer, MesssagePayload, BroadcastPeer, EVENTS, INNER_CALL, ERRORS } from './transport'
import EventEmmiter from './event-emitter'

export interface PeerInfo extends Peer {
  /**
   * 最后更新时间, 用于检测是否离线
   */
  lastUpdate: number
}

export interface StoragePayload<T = any> {
  target: string
  source: Peer
  data: MesssagePayload<T>
}

export type CheckAliveResponse = { status: 'ok' | 'correction' }

export const NAMESPACE = '_ITC_'
export const HEART_BEAT = 2500
export const MASTER_HEART_BEAT = 1000
export const ZOOMBIE_THRESHOLD = 4000
/**
 * NAMESPACE.type.desc
 */
const EVENT_REGEXP = new RegExp(`^${NAMESPACE}\\.([^\\.]*)$`)

export default class StorageTransport extends EventEmmiter implements Transport {
  id = uuid()
  private masterHeartBeatTimer?: number
  private heartBeatTimer?: number
  private peers: PeerInfo[] = []
  private currentMaster?: Peer
  private pendingPreempt?: () => void
  private storage = window.localStorage

  private get current(): Peer {
    return { id: this.id, name: this.name }
  }

  constructor(name: string, storage?: Storage) {
    super(name)
    if (storage) {
      this.storage = storage
    }
    console.log('current', this.id, this.name)
    this.initializeInnerHandler()
    this.connect()
  }

  destroy = () => {
    if (this.destroyed) {
      return
    }

    if (this.ready) {
      this.postMessage(BroadcastPeer, { type: EVENTS.DESTORY })
    }

    window.removeEventListener('storage', this.onStorage)
    document.removeEventListener('storage', this.onStorage)
    window.removeEventListener('unload', this.destroy)
    if (this.heartBeatTimer) {
      clearTimeout(this.heartBeatTimer)
      this.heartBeatTimer = undefined
    }

    if (this.masterHeartBeatTimer) {
      clearTimeout(this.masterHeartBeatTimer)
      this.masterHeartBeatTimer = undefined
    }

    this.emit('destroy')
    this.peers = []
    this.currentMaster = undefined
  }

  getMaster() {
    this.checkWorkerAvailable()
    return this.waitReady().then(() => this.currentMaster)
  }

  isMaster() {
    this.checkWorkerAvailable()
    return this.getMaster().then(master => {
      return !!master && master.id === this.id
    })
  }

  getPeers() {
    this.checkWorkerAvailable()
    return this.waitReady().then(() => this.peers)
  }

  private initializeInnerHandler() {
    // 响应master存活检查，如果当前不是master则忽略
    this.response(INNER_CALL.CHECK_ALIVE, (peer: Peer) => {
      if (this.currentMaster) {
        // 确定是master
        if (this.currentMaster.id === this.id) {
          return Promise.resolve({ status: 'ok' })
        } else {
          console.log('master correct', `from(${peer.name}) -> ${this.name}: ${this.currentMaster.name}`)
          // 纠错
          return Promise.resolve({ status: 'correction' })
        }
      }
      return Promise.reject(ERRORS.IGNORED)
    })
  }

  private async connect() {
    this.currentMaster = undefined
    window.addEventListener('storage', this.onStorage)
    document.addEventListener('storage', this.onStorage)
    window.addEventListener('unload', this.destroy)
    await this.checkMaster()
    this.heartbeat(true)
    this.emit('ready')
  }

  private onStorage = (evt: Event) => {
    const { key, newValue, oldValue } = evt as StorageEvent
    if (key == null || !key.startsWith(NAMESPACE) || newValue == null) {
      return false
    }

    const matched = key.match(EVENT_REGEXP)
    if (matched == null) {
      return false
    }

    const value = JSON.parse(newValue)
    const EVENT = matched[1]

    switch (EVENT) {
      case 'master':
        console.log('master', value, this.name)
        this.updateMaster(value as Peer)
        break
      case 'message':
        return this.handleMessage(value as StoragePayload)
        break
      default:
        console.warn(`[itc] unknown event: ${EVENT}`)
        return false
    }

    return true
  }

  private handleMessage(message: StoragePayload) {
    const { target, source, data } = message
    if (target !== this.id && target !== '*') {
      return false
    }

    if (source.id === this.id) {
      return false
    }

    switch (data.type) {
      case EVENTS.PING:
        this.postMessage(source, { type: EVENTS.PONG })
        break
      case EVENTS.PONG:
        return this.updatePeer(source)
      case EVENTS.DESTORY:
        this.removePeer(source)
        break
      case EVENTS.CALL:
        this.responseInternal(source, data.data)
        break
      case EVENTS.CALL_RESPONSE:
        this.callReturn(source, data.data)
        break
      case EVENTS.MESSAGE:
        this.emit('message', data.data)
        break
      default:
        console.warn(`[itc] unknown message event: ${data.type}`)
        return false
    }
    return true
  }

  /**
   * 同步检查自己是否是master
   */
  private async checkMaster(retry?: boolean) {
    await this.preemptMaster(retry)

    if (this.currentMaster!.id !== this.id) {
      // 开始检测定期检测master是否存活
      this.masterHeartBeat()
    } else if (this.masterHeartBeatTimer) {
      window.clearTimeout(this.masterHeartBeatTimer)
    }
  }

  private updateMaster(peer: Peer) {
    const prevMaster = this.currentMaster
    this.currentMaster = peer

    // master lose
    // 如果当前页面卡死，或者被断点阻塞，那么将无法响应其他tab，这时候其他Tab会重新尝试
    // 抢占master，从而产生新的master。这时候旧的master恢复了需要放弃master身份
    if (prevMaster && prevMaster.id === this.id && prevMaster.id !== this.currentMaster.id) {
      console.log('master lose', this.name)
      this.emit('masterlose')
      this.masterHeartBeat()
    }

    if (prevMaster == null || prevMaster.id !== peer.id) {
      if (peer.id === this.id) {
        this.emit('master')
      }
      this.emit('masterupdate', peer)
    }

    // 当前master正在抢占，终止抢占
    if (this.pendingPreempt) {
      this.pendingPreempt()
      this.pendingPreempt = undefined
    }
  }

  /**
   * 抢占master, 这里无法加锁, 所以产生竞态的多个tab, 这里的约定是选取最后设置master key
   * 的Tab作为master. 设置master key 会通过onstorage 通知到其他tabs
   */
  private async preemptMaster(retry?: boolean): Promise<void> {
    // 其他tabs已经抢占
    if (this.currentMaster) {
      return
    }

    const master = this.getItem('master') as Peer
    if (master && !retry) {
      // 等于自己, 返回
      if (master.id === this.id) {
        this.currentMaster = master
        this.emit('master')
        this.emit('masterupdate', master)
        return
      }

      try {
        // 检查是否存活
        const res: CheckAliveResponse = await this.callInternal(master, INNER_CALL.CHECK_ALIVE, [], 500)
        if (res.status === 'correction') {
          this.updateMaster(this.getItem('master'))
          return
        }

        console.log('master existed', master.id, this.id, this.name)
        this.currentMaster = master
        this.emit('masterupdate', master)
      } catch (err) {
        console.log('master no alive', master.id, this.id, this.name)
        // timeout, 未存活, 抢占
        // 让出控制权, 让浏览器可以处理其他事件, 减少冲突的概率
        await delay()
        return await this.preemptMaster(true)
      }
    } else {
      console.log('preempt master', this.name)
      this.setItem('master', this.current)
      await new Promise(res => {
        let fullfilled = false
        const checkout = () => {
          if (fullfilled) {
            return
          }

          fullfilled = true

          if (!this.currentMaster) {
            // 还没被抢占, 可能是单独打开的页面
            // 如果这时候有一个新页面打开会怎样? 不需要担心, Javascript是单线程的, 只有执行完这里,
            // 才会处理EVENTS.CHECK_ALIVE响应
            const master = this.getItem('master')
            this.currentMaster = master
            if (master.id === this.id) {
              this.emit('master')
            }
            this.emit('masterupdate', master)
          }

          // 其他tabs已经抢占
          res()
        }

        this.pendingPreempt = checkout
        window.setTimeout(checkout, 100)
      })
    }
  }

  /**
   * 定期检查master是否存活
   */
  private masterHeartBeat() {
    // become master, stop heartbeat
    if (this.currentMaster && this.currentMaster.id === this.id) {
      return
    }

    this.masterHeartBeatTimer = window.setTimeout(this.checkMasterAlive, MASTER_HEART_BEAT)
  }

  private checkMasterAlive = async () => {
    if (this.destroyed) {
      return
    }

    // 使用随机的重试次数，避免抢占冲突的概率
    const retryTimes = getRandomIntInclusive(2, 4)
    let currentMaster: Peer | undefined

    for (let i = 0; i < retryTimes; i++) {
      try {
        currentMaster = this.currentMaster
        const res: CheckAliveResponse = await this.callInternal(this.currentMaster!, INNER_CALL.CHECK_ALIVE, [], 1000)
        if (res.status === 'correction') {
          this.updateMaster(this.getItem('master'))
        }
        this.masterHeartBeat()
        break
      } catch (err) {
        if (i === retryTimes - 1) {
          // 到这一步, 可能别的tab已经开启抢占和更改master了
          // try -- |master change| -- catch
          if (currentMaster && currentMaster !== this.currentMaster) {
            this.masterHeartBeat()
          } else {
            // master dead
            this.currentMaster = undefined
            this.checkMaster(true)
          }
          break
        }

        await delay()
      }
    }
  }

  /**
   * 定期ping收集存活的peer
   */
  private heartbeat(immediate?: boolean) {
    this.heartBeatTimer = window.setTimeout(
      () => {
        if (this.destroyed) {
          return
        }

        this.postMessage(BroadcastPeer, { type: EVENTS.PING })
        this.updatePeers()
        this.heartbeat()
      },
      immediate ? 0 : HEART_BEAT,
    )
  }

  private updatePeer(peer: Peer) {
    if (peer.id === this.id) {
      return false
    }

    let dirty = false
    const idx = this.peers.findIndex(p => p.id === peer.id)
    if (idx !== -1) {
      if (!objEquals(this.peers[idx], peer, 'lastUpdate')) {
        dirty = true
      }
      this.peers[idx] = { ...peer, lastUpdate: Date.now() }
    } else {
      this.peers.push({ ...peer, lastUpdate: Date.now() })
      dirty = true
    }

    if (dirty) {
      this.emitPeerUpdate()
    }

    return dirty
  }

  private removePeer(peer: Peer) {
    const idx = this.peers.findIndex(p => p.id === peer.id)
    if (idx !== -1) {
      this.peers.splice(idx, 1)
      this.emitPeerUpdate()
    }
  }

  private updatePeers() {
    let peerToRemoves: Peer[] = []

    // check zoombie
    for (let i = 0, l = this.peers.length; i < l; i++) {
      const p = this.peers[i]
      if (Date.now() - p.lastUpdate > ZOOMBIE_THRESHOLD) {
        peerToRemoves.push(p)
      }
    }

    peerToRemoves.forEach(p => {
      const idx = this.peers.findIndex(i => i.id === p.id)
      if (idx !== -1) {
        this.peers.splice(idx, 1)
      }
    })

    if (peerToRemoves.length) {
      this.emitPeerUpdate()
    }
  }

  private emitPeerUpdate() {
    this.emit(
      'peerupdate',
      this.peers.map(({ id, name }) => ({
        id,
        name,
      })),
    )
  }

  protected postMessage(peer: Peer, data: MesssagePayload) {
    if (this.destroyed) {
      return
    }

    if (peer.id === this.id) {
      console.warn('cannot postMessage to self', data)
      return
    }

    const payload: StoragePayload = {
      target: peer.id as string,
      source: this.current,
      data,
    }
    this.setItem(`message`, payload)
  }

  private removeItem(key: string) {
    this.storage.removeItem(`${NAMESPACE}.${key}`)
  }

  private setItem(key: string, value: any) {
    this.storage.setItem(`${NAMESPACE}.${key}`, JSON.stringify(value))
  }

  private getItem(key: string) {
    const data = this.storage.getItem(`${NAMESPACE}.${key}`)
    if (data) {
      return JSON.parse(data)
    }
  }
}
