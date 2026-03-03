const path = require('path');

module.exports = {
  publicPath: '',
  configureWebpack: {
    resolve: {
      alias: {
        'ngraph.events': path.resolve(__dirname, 'node_modules/ngraph.events/index.js')
      }
    }
  }
}
