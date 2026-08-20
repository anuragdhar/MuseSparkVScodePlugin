const assert = require('node:assert/strict');
const Module = require('node:module');
const { JSDOM, VirtualConsole } = require('jsdom');

const vscodeMock = {
  workspace: {
    getConfiguration: () => ({
      get: (key) => key === 'useContributorPricing' ? true : key === 'backend' ? 'api' : undefined
    })
  },
  window: { activeTextEditor: undefined },
  commands: { executeCommand: () => undefined },
  Uri: { joinPath: (...parts) => parts.join('/') }
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return originalLoad.call(this, request, parent, isMain);
};

const { ChatViewProvider } = require('../out/chatPanel');
Module._load = originalLoad;

async function main() {
  let receiveFromWebview;
  const hostMessages = [];
  const webview = {
    options: {},
    html: '',
    onDidReceiveMessage: (handler) => { receiveFromWebview = handler; },
    postMessage: (message) => { hostMessages.push(message); return Promise.resolve(true); }
  };
  const view = { webview };
  const provider = new ChatViewProvider('extension-root');
  provider.agent = { run: async () => 'Automated response' };
  provider.resolveWebviewView(view);

  const outbound = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => { throw error; });
  const dom = new JSDOM(webview.html, {
    runScripts: 'dangerously',
    virtualConsole,
    beforeParse(window) {
      window.acquireVsCodeApi = () => ({
        postMessage(message) {
          outbound.push(message);
          if (receiveFromWebview) Promise.resolve(receiveFromWebview(message));
        }
      });
    }
  });

  const input = dom.window.document.getElementById('input');
  const button = dom.window.document.getElementById('sendButton');
  assert.ok(input, 'chat input exists');
  assert.ok(button, 'Send button exists');
  input.value = 'Automated send test';
  button.click();
  await new Promise(resolve => setTimeout(resolve, 25));

  const sent = outbound.find(message => message.type === 'send');
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), {
    type: 'send',
    text: 'Automated send test',
    includeContext: true
  });
  assert.ok(hostMessages.some(message => message.type === 'addMessage'), 'host received and echoed the user message');
  assert.ok(hostMessages.some(message => message.type === 'startStream'), 'host started the response');
  assert.ok(hostMessages.some(message => message.type === 'endStream' && message.content === 'Automated response'), 'host completed the response');
  console.log('PASS: clicking Send posted the prompt and completed the host response flow.');
  dom.window.close();
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
