"use strict";
/* 확장자별 텍스트 추출 디스패처. 실패는 예외로 올려 호출부가 기록한다. */
const fs = require("fs");
const path = require("path");
const { fromDocx, fromPptx, fromXlsx, fromHwpx } = require("./ooxml");
const { fromHwp } = require("./hwp");
const { fromPdf } = require("./pdf");

const TEXT_LIKE = new Set([".txt", ".md", ".csv", ".json"]);

function readTextFile(file) {
  const buf = fs.readFileSync(file);
  // UTF-8 BOM / UTF-16 판별, 아니면 CP949 가능성 → 우선 UTF-8 로 읽고 깨짐이 심하면 latin1 유지
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString("utf16le");
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.slice(3).toString("utf8");
  const utf8 = buf.toString("utf8");
  const bad = (utf8.match(/�/g) || []).length;
  if (bad > 0 && bad / Math.max(utf8.length, 1) > 0.01) {
    try {
      return new TextDecoder("euc-kr").decode(buf);
    } catch (_) {
      return utf8;
    }
  }
  return utf8;
}

async function extractText(file) {
  const ext = path.extname(file).toLowerCase();
  if (TEXT_LIKE.has(ext)) return readTextFile(file);
  const buf = fs.readFileSync(file);
  switch (ext) {
    case ".pdf":
      return await fromPdf(buf);
    case ".hwp":
      return fromHwp(buf);
    case ".hwpx":
      return fromHwpx(buf);
    case ".docx":
      return fromDocx(buf);
    case ".pptx":
      return fromPptx(buf);
    case ".xlsx":
      return fromXlsx(buf);
    default:
      throw new Error("지원하지 않는 형식: " + ext);
  }
}

module.exports = { extractText };
