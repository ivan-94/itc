/**
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
 * + target: id, 接收者id, 非接收者应该忽略掉
 * + type: 类型
 * + data: 消息类型
 */
import { uuid, delay, getRandomIntInclusive, objEquals } from '../utils'

import { Transport, Peer, MesssagePayload, EVENTS } from './transport'
import EventEmmiter from './event-emitter'

interface PeerInfo {
  /**
   * 最后更新时间, 用于检测是否离线
   */
  lastUpdate: number
  /**
   * peer唯一id
   */
  id: number | string
  /**
   * peer 名称
   */
  name?: string
}

interface StoragePayload {
  target: string
  source: Peer
  data: MesssagePayload
}

const NAMESPACE = '_ITC_'
const HEART_BEAT = 2500
const ZOOMBIE_THRESHOLD = 4000
/**
 * NAMESPACE.type.desc
 */
const EVENT_REGEXP = new RegExp(`^${NAMESPACE}\\.([^\\.]*)(\\.(.*))?$`)
const BroadcastPeer = { id: '*', name: 'broadcast' }

export default class StorageTransport extends EventEmmiter implements Transport {
  destroyed: boolean = false
  private id = uuid()
  private masterHeartBeatTimer?: number
  private heartBeatTimer?: number
  private peers: PeerInfo[] = []
  private currentMaster?: Peer
  private name?: string
  private ready: boolean = false
  private pendingPreempt?: () => void
  private callbacks: {
    [id: string]: Array<(data: any) => void>
  } = {}
  private storage = window.localStorage

  private get current(): Peer {
    return { id: this.id, name: this.name }
  }

  constructor() {
    super()
    console.log('current', this.id)
    this.connect()
  }

  destroy = () => {
    if (this.destroyed) {
      return
    }
    this.destroyed = true
    window.removeEventListener('storage', this.onStorage)
    window.removeEventListener('unload', this.destroy)
    if (this.heartBeatTimer) {
      clearTimeout(this.heartBeatTimer)
      this.heartBeatTimer = undefined
    }
    if (this.masterHeartBeatTimer) {
      clearTimeout(this.masterHeartBeatTimer)
      this.masterHeartBeatTimer = undefined
    }
    // TODO: destroy events
  }

  send(data: any, peer?: Peer) {}

  getMaster() {
    return Promise.resolve(this.currentMaster!)
  }

  getPeers() {
    return Promise.resolve(this.peers)
  }

  setName() {
    this.name = this.name
  }

  getName() {
    return this.name
  }

  private onStorage = (evt: StorageEvent) => {
    const { key, newValue, oldValue } = evt
    if (key == null || !key.startsWith(NAMESPACE) || newValue == null) {
      return
    }

    const matched = key.match(EVENT_REGEXP)
    if (matched == null) {
      return
    }

    const value = JSON.parse(newValue)
    const EVENT = matched[1]
    const EVENT_DESC = matched[3]

    switch (EVENT) {
      case 'master':
        console.log('master', value)
        this.updateMaster(value as Peer)
        break
      case 'message':
        this.handleMessage(value as StoragePayload)
        break
    }
  }

  private handleMessage(message: StoragePayload) {
    const { target, source, data } = message
    if (target !== this.id && target !== '*') {
      return
    }

    console.log(message)
    // TODO: handleMessage
    switch (data.type) {
      case EVENTS.PING:
        this.postMessage(source, { type: EVENTS.PONG })
        break
      case EVENTS.PONG:
        this.updatePeer(source)
        break
      case EVENTS.CONNECT:
        this.postMessage(source, { type: EVENTS.CONNECTED })
        break
      case EVENTS.CHECK_ALIVE:
        // 只有master才能响应
        if (this.currentMaster && this.currentMaster.id === this.id) {
          this.postMessage(source, { type: EVENTS.CHECK_ALIVE })
        } else {
          this.response(data)
        }
        break
      default:
        this.response(data)
        break
    }
  }

  private async connect() {
    this.currentMaster = undefined
    window.addEventListener('storage', this.onStorage)
    window.addEventListener('unload', this.destroy)
    await this.checkMaster()
    this.heartbeat()
    this.ready = true
    this.emit('ready')
    // TODO: flush queue
  }

  /**
   * 同步检查自己是否是master
   */
  private async checkMaster(retry?: boolean) {
    await this.preemptMaster(retry)
    if (this.currentMaster!.id !== this.id) {
      this.masterHeartBeat()
    } else if (this.masterHeartBeatTimer) {
      window.clearTimeout(this.masterHeartBeatTimer)
    }
  }

  private updateMaster(peer: Peer) {
    const prevMaster = this.currentMaster
    this.currentMaster = peer
    // master lose
    if (prevMaster && prevMaster.id === this.id && prevMaster.id !== this.currentMaster.id) {
      console.log('master lose')
      this.emit('masterlose')
      this.masterHeartBeat()
    }

    if (this.currentMaster == null || this.currentMaster.id !== peer.id) {
      if (peer.id === this.id) {
        this.emit('master')
      }
      this.emit('masterupdate', peer)
    }

    if (this.pendingPreempt) {
      this.pendingPreempt()
      this.pendingPreempt = undefined
    }
  }

  /**
   * 抢占master, 这里无法加锁, 所以产生竞态的多个tab, 选取最后的设置的作为master
   * 会通过onstorage 通知到其他tabs
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
        return
      }

      try {
        // 检查是否存活
        await this.call(master, EVENTS.CHECK_ALIVE, undefined, 1000)
        console.log('master existed', master.id, this.id)
        this.currentMaster = master
      } catch (err) {
        console.log('master no alive', master.id, this.id)
        // timeout, 未存活, 抢占
        return await this.preemptMaster(true)
      }
    } else {
      console.log('preempt master')
      this.setItem('master', this.current)
      await new Promise(res => {
        let fullfilled = false
        const checkout = () => {
          if (fullfilled) {
            return
          }

          fullfilled = true

          // 其他tabs已经抢占
          if (!this.currentMaster) {
            // 还没被抢占, 可能是单独打开的页面
            // 如果这时候有一个新页面打开会怎样? 不需要担心, Javascript是单线程的, 只有执行完这里,
            // 才会处理EVENTS.CHECK_ALIVE响应
            const master = this.getItem('master')
            this.currentMaster = master
            if (master.id === this.id) {
              this.emit('master')
            }
          }
          res()
        }
        this.pendingPreempt = checkout
        window.setTimeout(checkout, 100)
      })
    }
  }

  private masterHeartBeat() {
    // lose
    if (this.currentMaster && this.currentMaster.id === this.id) {
      return
    }

    this.masterHeartBeatTimer = window.setTimeout(async () => {
      const retryTimes = getRandomIntInclusive(2, 4)
      let currentMaster: Peer | undefined
      for (let i = 0; i < retryTimes; i++) {
        try {
          currentMaster = this.currentMaster!
          await this.call(this.currentMaster!, EVENTS.CHECK_ALIVE, undefined, 1000)
          this.masterHeartBeat()
          break
        } catch (err) {
          if (i === retryTimes - 1) {
            // 到这一步, 可能别人已经开启抢占和更改master了
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
    }, 1000)
  }

  /**
   * 定期ping收集存活的peer
   */
  private heartbeat() {
    this.heartBeatTimer = setTimeout(() => {
      // master change
      this.postMessage(BroadcastPeer, { type: EVENTS.PING })
      this.updatePeers()
      this.heartbeat()
    }, HEART_BEAT)
  }

  private updatePeer(peer: Peer) {
    if (peer.id === this.id) {
      return
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
      this.emit('peerupdate', this.peers)
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
      this.emit('peerupdate', this.peers)
    }
  }

  private call(peer: Peer, name: string, data: any, timeout?: number): Promise<any> {
    return new Promise((res, rej) => {
      let fullfilled = false

      const resolver = (data: any) => {
        if (fullfilled) {
          return
        }
        fullfilled = true
        res(data)
      }

      if (this.callbacks[name]) {
        this.callbacks[name].push(resolver)
      } else {
        this.callbacks[name] = [resolver]
      }

      this.postMessage(peer, { type: name, data })

      if (timeout != null) {
        setTimeout(() => {
          if (fullfilled) {
            return
          }
          fullfilled = true
          rej(new Error('timeout'))
        }, timeout)
      }
    })
  }

  private response(message: MesssagePayload) {
    const { type, data } = message
    if (this.callbacks[type] && this.callbacks[type].length) {
      const queue = this.callbacks[type]
      this.callbacks[type] = []
      queue.forEach(res => res(data))
    }
  }

  private postMessage(peer: Peer, data: MesssagePayload) {
    if (peer.id === this.id) {
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