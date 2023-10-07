const path = require('path');
const TestPlugin = require('./plugins/test-plugin').TestPlugin;

module.exports = {
    entry: {
      main: './src/index.ts',
    },
    builtins: {
      html: [{ template: './src/index.html' }],
    },
    //For each locale we will have a chunk with the specified namespace module in them 
    // In the below example will have : some-chunk-locale-en-us.js and some-chunk-locale-en-gb.js containing the namespace2 module only and not namespace1.
    plugins: [new TestPlugin({    chunks: [
        {
          name: "some-chunk",
          namespaces: ["namespace2"],
        },
      ]})]
  };