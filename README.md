# ITC

`Inter-Tabs-Communication` 跨浏览器 Tab/iframe 通信. 基于`SharedWorker`, 对于不支持`SharedWorker`的浏览器
将回退为`StorageEvent`方案.

[EXAMPLE](https://carney520.github.io/itc/)

## 安装

```shell
yarn add @carney520/itc
```

## 基本使用

```js
import itc from '@carney520/itc'

const worker = itc('name')
const currentMaster
const currentPeers = []

itc.on('master', () => {
  // become master
})

itc.on('masterlose', () => {
  // master lose. 如果页面被阻塞, 例如debug, 将导致页面无法回复心跳, 从而导致其他页面认为页面已经销毁.
  // 这时候页面恢复执行后, 其他页面可能已经抢占了master的地位
})

itc.on('masterupdate', master => {
  // 监听master的变化, 类型为{id: string, name}
  currentMaster = master
})

itc.on('peerupdate', peers => {
  // 监听其他页面的变化, peers是一个包含其他页面的列表, 类型为Array<{id: string, name: string}>
  currentPeers = peers
})

// broadcast
itc.send('121')

itc.on('message', message => {
  const { data, source } = message
  // 发送给指定peer
  itc.send('response', source)
})

```

## API

```typescript
export type Disposer = () => void

export interface Peer {
  id: string | number
  name: string
}

export interface Message<T = any> {
  data: T
  source: Peer
}

interface Transport {
  // meta datas
  readonly name?: string
  readonly destroyed: boolean
  readonly current: Peer
  setCallTimeout(time: number): void

  /**
   * listen message | master event
   */
  on(event: 'ready', handler: () => void): Disposer
  on(event: 'master', handler: () => void): Disposer
  on(event: 'masterlose', handler: () => void): Disposer
  on(event: 'message', handler: (data: Message) => void): Disposer
  on(event: 'peerupdate', handler: (data: Peer[]) => void): Disposer
  on(event: 'masterupdate', handler: (data: Peer) => void): Disposer

  /**
   * remove listener
   */
  off(event: string, handler: (data: any) => void): void

  /**
   * send message to other tabs
   */
  send(data: any, peer?: Peer): void

  /**
   * call function on other tab
   */
  call(peer: Peer, name: string, ...args: any[]): Promise<any>

  /**
   * response call
   */
  response(
    name: string,
    handler: (peer: Peer, ...args: any[]) => Promise<any>,
  ): void

  /**
   * get current Master
   */
  getMaster(): Promise<Peer | undefined>

  isMaster(): Promise<boolean>

  /**
   * get all other tabs(peers)
   */
  getPeers(): Promise<Peer[]>

  /**
   * destroy
   */
  destroy(): void
}
```
