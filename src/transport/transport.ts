export type Disposer = () => void

export interface Peer {
  id: string | number
  name?: string
}

export interface Transport {
  // meta datas
  /**
   * set worker name
   */
  setName(name: string): void
  /**
   * get worker name
   */
  getName(): string | undefined
  /**
   * listen custom events
   */
  on(event: string, handler: (data: any) => void): Disposer
  /**
   * listen message | master event
   */
  on(event: 'ready', handler: () => void): Disposer
  on(event: 'master', handler: () => void): Disposer
  on(event: 'masterlose', handler: () => void): Disposer
  on(event: 'message', handler: (data: any) => void): Disposer
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
   * emit custom event
   */
  emit(event: string, data?: any): void

  destroyed: boolean

  /**
   * destroy
   */
  destroy(): void

  /**
   * get current Master
   */
  getMaster(): Promise<Peer>

  /**
   * get all other tabs(peers)
   */
  getPeers(): Promise<Peer[]>
}

export interface MesssagePayload {
  type: string
  data?: any
}

export const EVENTS = {
  CONNECT: 'CONNECT',
  CONNECTED: 'CONNECTED',
  PONG: 'PONG',
  PING: 'PING',
  BECOME_MASTER: 'BECOME_MASTER',
  DESTORY: 'DESTROY',
  MESSAGE: 'MESSAGE',
  SETNAME: 'SET_NAME',
  UPDATE_PEERS: 'UPDATE_PEERS',
  UPDATE_MASTER: 'UPDATE_MASTER',
  SYNC: 'SYNC',

  // duplex
  GET_PEERS: 'GET_PEERS',
  GET_MASTER: 'GET_MASTER',
  CHECK_ALIVE: 'CHECK_ALIVE',
}
