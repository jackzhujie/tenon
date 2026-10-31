import { render } from './lib/counter.js'

render(document.querySelector('#app'))

if (import.meta.hot) {
  import.meta.hot.accept('./lib/counter.js', (mod) => {
    mod.render(document.querySelector('#app'))
  })
}
