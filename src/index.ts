import { Transport, Worker } from './transport'

export default function create() {
  return new Worker() as Transport
}
