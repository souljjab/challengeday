// BpmChart.dc.html 을 dc-bundle.js 안에 미리 담아 둡니다.
// 브라우저는 file:// 로 연 페이지에서 다른 파일을 fetch 할 수 없어서,
// 디자인 런타임(support.js)이 하위 컴포넌트를 이 번들에서 읽게 합니다.
// BpmChart.dc.html 을 고친 뒤에는 `node tools/build-bundle.js` 를 다시 실행하세요.
const fs = require('fs');
const path = require('path');

const appDir = path.join(__dirname, '..', 'app');
const components = ['BpmChart'];

const entries = components.map(name => {
  const src = fs.readFileSync(path.join(appDir, name + '.dc.html'), 'utf8');
  return `  ${JSON.stringify('./' + name + '.dc.html')}: ${JSON.stringify(src)}`;
});

const out = `// 자동 생성 파일 — 직접 고치지 말고 \`node tools/build-bundle.js\` 로 다시 만드세요.
(function () {
  var src = {
${entries.join(',\n')}
  };
  window.__resources = window.__resources || {};
  var blobs = window.__resourceBlobs = window.__resourceBlobs || {};
  for (var k in src) blobs[k] = new Blob([src[k]], { type: 'text/html' });
})();
`;
fs.writeFileSync(path.join(appDir, 'dc-bundle.js'), out);
console.log('wrote app/dc-bundle.js (' + components.join(', ') + ')');
