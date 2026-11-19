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

function assertOneReference(source, needle, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) {
    throw new Error(`Expected exactly one ${label} reference in index.html, found ${count}.`);
  }
}

const xlsxTag = '<script src="./vendor/xlsx.full.min.js"></script>';
const repositoryTag = '<script src="./repository.js"></script>';
const xlsxSlot = '<!-- BUILDBOOK_XLSX_BUNDLE -->';
const repositorySlot = '<!-- BUILDBOOK_REPOSITORY_BUNDLE -->';
assertOneReference(html, xlsxTag, 'SheetJS');
assertOneReference(html, repositoryTag, 'IndexedDB repository');

let standalone = html.replace(xlsxTag, xlsxSlot).replace(repositoryTag, repositorySlot);
if (/<script\\s+src=/i.test(standalone)) {
  throw new Error('The standalone template still contains an external script dependency.');
}
standalone = standalone.replace(
  xlsxSlot,
  `<script>
/* Bundled locally from vendor/xlsx.full.min.js. */
${xlsx}
</script>`
);
standalone = standalone.replace(
  repositorySlot,
  `<script>
/* Bundled locally from repository.js. */
${repository}
</script>`
);

if (standalone.includes(xlsxSlot) || standalone.includes(repositorySlot)) {
  throw new Error('A standalone bundle placeholder was not replaced.');
}

await writeFile(outputPath, standalone, 'utf8');
console.log(`Built ${outputPath} (${Buffer.byteLength(standalone, 'utf8')} bytes).`);
