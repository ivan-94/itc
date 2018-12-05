type Disposer = () => void

export type ITCEvents = 'message' | 'master'

export interface Transport {
  /**
   * listen custom events
   */
  on(event: string, handler: (data: any) => void): Disposer
  /**
   * listen message | master event
   */
  on(event: ITCEvents, handler: (data: any) => void): Disposer
  /**
   * remove listener
   */
  off(event: string, handler: (data: any) => void): void
  /**
   * send message to other tabs
   */
  send(data: any): void
  /**
   * emit custom event
   */
  emit(event: string, data?: any): void
  /**
   * destroy
   */
  destroy(): void
}

export interface MesssagePayload {
  type: string
  data: any
}
