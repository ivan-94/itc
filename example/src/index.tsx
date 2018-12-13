/**
 * App entry
 */
import React, { useState } from 'react'
import ReactDOM from 'react-dom'

import './style.css'

const peers = ['A', 'B', 'C', 'D']

function App() {
  const [sleeping, setSleeping] = useState<{ [key: string]: boolean | undefined }>({})
  return (
    <div className="container">
      {peers.map(p => {
        const isSleeping = sleeping[p]
        return (
          <div className="peer-container" key={p}>
            {isSleeping ? <div className="placeholder">sleeping</div> : <iframe src={`peer.html?name=${p}`} />}
            <div>
              <button
                // tslint:disable-next-line:jsx-no-lambda
                onClick={() => {
                  sleeping[p] = !sleeping[p]
                  setSleeping(sleeping)
                }}
              >
                {isSleeping ? 'wake' : 'sleep'}
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

ReactDOM.render(<App />, document.getElementById('root'))
