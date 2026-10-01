"use strict";
/* ZIP 기반 문서(docx/pptx/xlsx/hwpx)에서 텍스트를 뽑는다. */
const { unzipSync, strFromU8 } = require("fflate");

function unzip(buf) {
  return unzipSync(new Uint8Array(buf));
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

/*
 * XML 에서 텍스트 태그(textTag)의 내용을 순서대로 모으고,
 * 문단 종료 태그(paraTag)를 만나면 줄바꿈을 넣는다.
 * 태그 이름은 호출부가 고정 리터럴로 넘기므로 정규식 이스케이프는 하지 않는다.
 */
function tagText(xml, textTag, paraTag) {
  const parts = [];
  const re = new RegExp(
    "<" + textTag + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + textTag + ">" +
      (paraTag ? "|</" + paraTag + ">" : ""),
    "g"
  );
  let m;
  while ((m = re.exec(xml))) {
    if (m[1] === undefined) parts.push("\n");
    else parts.push(decodeEntities(m[1].replace(/<[^>]*>/g, "")));
  }
  return parts.join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
}

function fromDocx(buf) {
  const z = unzip(buf);
  return ["word/document.xml", "word/footnotes.xml", "word/endnotes.xml"]
    .filter((p) => z[p])
    .map((p) => tagText(strFromU8(z[p]), "w:t", "w:p"))
    .join("\n")
    .trim();
}

function fromPptx(buf) {
  const z = unzip(buf);
  const num = (s) => Number((s.match(/(\d+)\.xml$/) || [0, 0])[1]);
  const slides = Object.keys(z)
    .filter((p) => /^ppt\/(slides|notesSlides)\/[^/]+\.xml$/.test(p))
    .sort((a, b) => (a.includes("notes") ? 1 : 0) - (b.includes("notes") ? 1 : 0) || num(a) - num(b));
  const out = [];
  for (const p of slides) {
    const label = p.includes("notes") ? "[노트]" : "[슬라이드]";
    const name = p.replace(/^ppt\/[^/]+\//, "").replace(/\.xml$/, "");
    const t = tagText(strFromU8(z[p]), "a:t", "a:p").trim();
    if (t) out.push(label + " " + name + "\n" + t);
  }
  return out.join("\n\n").trim();
}

function fromXlsx(buf) {
  const z = unzip(buf);
  let shared = [];
  if (z["xl/sharedStrings.xml"]) {
    const xml = strFromU8(z["xl/sharedStrings.xml"]);
    shared = [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
      decodeEntities(m[1].replace(/<[^>]*>/g, ""))
    );
  }
  const sheets = Object.keys(z)
    .filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p))
    .sort();
  const out = [];
  for (const p of sheets) {
    const xml = strFromU8(z[p]);
    const lines = [];
    for (const r of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      // 빈 셀은 <c r="A1"/> 처럼 자기닫힘으로 나오므로 두 형태를 함께 처리한다.
      // (자기닫힘을 따로 잡지 않으면 다음 셀의 속성과 값이 어긋난다)
      for (const c of r[1].matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const body = c[2];
        if (body === undefined) { cells.push(""); continue; }
        const type = (c[1].match(/\bt="(\w+)"/) || [])[1];
        const v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        if (type === "s") cells.push(shared[Number(v)] ?? "");
        else if (type === "inlineStr" || type === "str") cells.push(decodeEntities(body.replace(/<[^>]*>/g, "")));
        else cells.push(v ? decodeEntities(v) : "");
      }
      const line = cells.join("\t").trim();
      if (line) lines.push(line);
    }
    if (lines.length) out.push("[시트] " + p.replace("xl/worksheets/", "") + "\n" + lines.join("\n"));
  }
  return out.join("\n\n").trim();
}

function fromHwpx(buf) {
  const z = unzip(buf);
  const secs = Object.keys(z)
    .filter((p) => /^Contents\/section\d+\.xml$/i.test(p))
    .sort();
  return secs.map((p) => tagText(strFromU8(z[p]), "hp:t", "hp:p")).join("\n").trim();
}

module.exports = { fromDocx, fromPptx, fromXlsx, fromHwpx, decodeEntities };
