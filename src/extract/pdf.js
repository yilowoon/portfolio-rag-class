"use strict";
/* pdfjs-dist 로 PDF 텍스트 추출(페이지 구분 유지). */
let pdfjs = null;
async function lib() {
  if (!pdfjs) pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjs;
}

async function fromPdf(buf, { maxPages = 300 } = {}) {
  const { getDocument } = await lib();
  const task = getDocument({
    data: new Uint8Array(buf),
    useSystemFonts: true,
    isEvalSupported: false,
    disableFontFace: true,
    verbosity: 0,
  });
  const doc = await task.promise;
  const pages = [];
  const n = Math.min(doc.numPages, maxPages);
  for (let i = 1; i <= n; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    let line = [];
    const lines = [];
    let lastY = null;
    for (const it of tc.items) {
      if (!("str" in it)) continue;
      const y = it.transform ? Math.round(it.transform[5]) : null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) {
        lines.push(line.join("").trim());
        line = [];
      }
      line.push(it.str);
      if (it.hasEOL) { lines.push(line.join("").trim()); line = []; }
      lastY = y;
    }
    if (line.length) lines.push(line.join("").trim());
    const text = lines.filter(Boolean).join("\n");
    if (text) pages.push(`[p.${i}]\n${text}`);
    page.cleanup();
  }
  await doc.destroy();
  return pages.join("\n\n");
}

module.exports = { fromPdf };
