const fs = require('fs');
const s = fs.readFileSync('src/App.jsx', 'utf8');
const tags = ['div','label','select','option','input','canvas','datalist','button','span','h1','small','strong'];
for (const t of tags) {
  const open = (s.match(new RegExp(`<${t}(\\s|>)`, 'g')) || []).length;
  const close = (s.match(new RegExp(`</${t}>`, 'g')) || []).length;
  const self = (s.match(new RegExp(`<${t}[^>]*?/\s*>`, 'g')) || []).length;
  console.log(t, 'open=', open, 'close=', close, 'selfClosing=', self);
}
