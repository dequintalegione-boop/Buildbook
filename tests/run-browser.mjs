import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const pageErrors = [];

page.on('pageerror', error => pageErrors.push(error.message));

try {
  await page.goto('http://127.0.0.1:4173/tests/test-runner.html', {
    waitUntil: 'load',
    timeout: 30000
  });

  await page.waitForFunction(
    () => document.querySelector('#summary')?.textContent.startsWith('Готово:'),
    null,
    { timeout: 120000 }
  );

  const summary = await page.locator('#summary').innerText();
  const results = await page.locator('#results li').allTextContents();
  const failed = results.filter(line => line.startsWith('✗'));

  console.log(summary);
  for (const line of results) console.log(line);

  if (failed.length || pageErrors.length) {
    if (pageErrors.length) {
      console.error('Ошибки JavaScript:', pageErrors.join('; '));
    }
    process.exitCode = 1;
  }
} catch (error) {
  console.error('Не удалось выполнить браузерные тесты:', error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
