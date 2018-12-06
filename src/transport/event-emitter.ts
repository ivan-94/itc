export type Handler = (data: any) => void
export default abstract class EventEmitter {
  private queue: { [name: string]: Array<Handler> } = {}
  on(event: string, handle: Handler) {
    if (event in this.queue) {
      this.queue[event].push(handle)
    } else {
      this.queue[event] = [handle]
    }

    return () => {
      this.off(event, handle)
    }
  }

  off(event: string, handle: Handler) {
    if (event in this.queue) {
      const idx = this.queue[event].indexOf(handle)
      if (idx !== -1) {
        this.queue[event].splice(idx, 1)
      }
    }
  }

  emit(event: string, data?: any) {
    if (event in this.queue) {
      const handles = [...this.queue[event]]
      handles.forEach(h => h(data))
    }
  }
}
