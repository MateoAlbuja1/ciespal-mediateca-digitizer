const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'www');

function copyFile(source, target) {
  if (!fs.existsSync(source)) {
    throw new Error(`Missing build input: ${source}`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

fs.mkdirSync(outDir, { recursive: true });
fs.rmSync(path.join(outDir, 'public'), { recursive: true, force: true });

copyFile(path.join(root, 'index.html'), path.join(outDir, 'index.html'));
copyFile(path.join(root, 'style.css'), path.join(outDir, 'style.css'));
copyFile(path.join(root, 'app.js'), path.join(outDir, 'app.js'));
copyFile(path.join(root, 'public', 'opencv.js'), path.join(outDir, 'opencv.js'));
fs.rmSync(path.join(outDir, 'config.js'), { force: true });

console.log(`CIESPAL web bundle ready: ${outDir}`);
