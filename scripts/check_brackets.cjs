const fs = require('fs');
const s = fs.readFileSync('src/App.jsx', 'utf8');
let stack = [];
const pairs = { '(': ')', '{': '}', '[': ']' };
for (let i = 0; i < s.length; i++) {
  const c = s[i];
  if ('({['.includes(c)) stack.push({ c, i });
  else if (')}]'.includes(c)) {
    if (stack.length === 0) {
      console.log('Unmatched closing', c, 'at', i);
      process.exit(1);
    }
    const last = stack.pop();
    if (pairs[last.c] !== c) {
      console.log('Mismatched', last.c, 'at', last.i, 'with', c, 'at', i);
      process.exit(1);
    }
  }
}
if (stack.length) {
  console.log('Unmatched openings:');
  stack.forEach((x) => console.log(x.c, 'at', x.i));
  process.exit(1);
}
console.log('All brackets balanced');
