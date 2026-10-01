"use strict";
/*
 * HWP 5.x(한글 바이너리) 본문 텍스트 추출.
 * 구조: OLE(CFB) 컨테이너 → BodyText/SectionN 스트림 → (압축 시) raw deflate
 *      → 레코드 스트림(헤더 4바이트: tag 10bit | level 10bit | size 12bit)
 *      → HWPTAG_PARA_TEXT(67) 레코드의 UTF-16LE 본문.
 */
const zlib = require("zlib");
const CFB = require("cfb");

const TAG_PARA_TEXT = 67; // HWPTAG_BEGIN(0x10) + 51
// 8워드(16바이트)를 차지하는 확장 제어문자
const EXT_CTRL = new Set([1, 2, 3, 11, 12, 14, 15, 16, 17, 18, 21, 22, 23]);
// 1워드짜리 제어문자(대부분 무시, 10/13 은 줄바꿈)
const INLINE_CTRL = new Set([4, 5, 6, 7, 8, 9, 19, 20, 24, 25, 26, 27, 28, 29, 30, 31]);

function findStream(cfb, re) {
  return (cfb.FullPaths || []).map((p, i) => ({ p, i })).filter(({ p }) => re.test(p));
}

function readParaText(buf) {
  let out = "";
  for (let i = 0; i + 1 < buf.length; ) {
    const c = buf.readUInt16LE(i);
    if (c === 10 || c === 13) { out += "\n"; i += 2; continue; }
    if (c === 0) { i += 2; continue; }
    if (EXT_CTRL.has(c)) { i += 16; continue; }
    if (INLINE_CTRL.has(c)) { i += 2; continue; }
    out += String.fromCharCode(c);
    i += 2;
  }
  return out;
}

function parseRecords(buf) {
  const paras = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const header = buf.readUInt32LE(pos);
    const tag = header & 0x3ff;
    let size = (header >> 20) & 0xfff;
    pos += 4;
    if (size === 0xfff) {
      if (pos + 4 > buf.length) break;
      size = buf.readUInt32LE(pos);
      pos += 4;
    }
    if (pos + size > buf.length) break;
    if (tag === TAG_PARA_TEXT) paras.push(readParaText(buf.subarray(pos, pos + size)));
    pos += size;
  }
  return paras.join("\n");
}

function inflate(buf) {
  try { return zlib.inflateRawSync(buf); } catch (_) {}
  try { return zlib.inflateSync(buf); } catch (_) {}
  return null;
}

function fromHwp(buf) {
  const cfb = CFB.read(buf, { type: "buffer" });

  // FileHeader: 32바이트 시그니처 + 4바이트 버전 + 4바이트 속성플래그
  let compressed = true;
  let drm = false;
  const fh = CFB.find(cfb, "FileHeader");
  if (fh && fh.content && fh.content.length >= 40) {
    const c = Buffer.from(fh.content);
    const flags = c.readUInt32LE(36);
    compressed = (flags & 0x01) === 0x01;
    drm = (flags & 0x02) === 0x02;
  }
  if (drm) throw new Error("배포용(DRM) 문서라 본문을 열 수 없음");

  const sections = findStream(cfb, /BodyText\/Section\d+$/i)
    .sort((a, b) => Number(a.p.match(/(\d+)$/)[1]) - Number(b.p.match(/(\d+)$/)[1]));
  if (!sections.length) throw new Error("BodyText 섹션 없음");

  const out = [];
  for (const { i } of sections) {
    const entry = cfb.FileIndex[i];
    if (!entry || !entry.content) continue;
    let raw = Buffer.from(entry.content);
    if (compressed) {
      const inf = inflate(raw);
      if (!inf) continue;
      raw = Buffer.from(inf);
    }
    const t = parseRecords(raw).trim();
    if (t) out.push(t);
  }
  const text = out.join("\n\n");
  if (!text.trim()) throw new Error("본문 텍스트를 찾지 못함");
  return text;
}

module.exports = { fromHwp };
