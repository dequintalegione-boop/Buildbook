import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const htmlPath = resolve(root, 'index.html');
const repositoryPath = resolve(root, 'repository.js');
const xlsxPath = resolve(root, 'vendor/xlsx.full.min.js');
const outputPath = resolve(root, 'Buildbook-standalone.html');

const [html, repository, xlsx] = await Promise.all([
  readFile(htmlPath, 'utf8'),
  readFile(repositoryPath, 'utf8'),
  readFile(xlsxPath, 'utf8')
]);

function replaceExactlyOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) {
    throw new Error(`Expected exactly one ${label} reference in index.html, found ${count}.`);
  }
  return source.replace(needle, replacement);
}

let standalone = html;
standalone = replaceExactlyOnce(
  standalone,
  '<script src="./vendor/xlsx.full.min.js"></script>',
  `<script>
/* Bundled locally from vendor/xlsx.full.min.js. */
${xlsx}
</script>`,
  'SheetJS'
);
standalone = replaceExactlyOnce(
  standalone,
  '<script src="./repository.js"></script>',
  `<script>
/* Bundled locally from repository.js. */
${repository}
</script>`,
  'IndexedDB repository'
);

if (standalone.includes('src="./repository.js"') || standalone.includes('src="./vendor/xlsx.full.min.js"')) {
  throw new Error('The standalone bundle still references an external repository or SheetJS file.');
}

await writeFile(outputPath, standalone, 'utf8');
console.log(`Built ${outputPath} (${Buffer.byteLength(standalone, 'utf8')} bytes).`);
