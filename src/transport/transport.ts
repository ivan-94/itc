export type Disposer = () => void

export interface Peer {
  id: string | number
  name: string
}

export interface Message<T = any> {
  data: T
  source: Peer
}

export interface Transport {
  // meta data
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
  response(name: string, handler: (peer: Peer, ...args: any[]) => Promise<any>): void

  /**
   * destroy
   */
  destroy(): void

  /**
   * get current Master
   */
  getMaster(): Promise<Peer | undefined>
  isMaster(): Promise<boolean>

  /**
   * get all other tabs(peers)
   */
  getPeers(): Promise<Peer[]>
}

export interface MessagePayload<T = any> {
  type: string
  data?: T
}

export const EVENTS = {
  CONNECTED: 'CONNECTED',
  INITIAL: 'INITIAL',
  PONG: 'PONG',
  PING: 'PING',
  BECOME_MASTER: 'BECOME_MASTER',
  DESTROY: 'DESTROY',
  MESSAGE: 'MESSAGE',
  UPDATE_PEERS: 'UPDATE_PEERS',
  UPDATE_MASTER: 'UPDATE_MASTER',

  // duplex
  CALL: 'CALL',
  CALL_RESPONSE: 'CALL_RESPONSE',
}

export const ERRORS = {
  NOT_FOUND: 'NOT_FOUND',
  IGNORED: 'IGNORED',
}

export const INNER_CALL = {
  CHECK_ALIVE: 'CHECK_ALIVE',
}

export const BroadcastPeer = {
  id: '*',
  name: 'broadcast',
}
