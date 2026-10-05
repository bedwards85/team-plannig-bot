import { describe, expect, it } from "vitest";
import { csvCell, detectDelimiter, parseCsv, toCsv, toCsvRow, type CsvDelimiter } from "../src/eval/csv.js";

describe("csvCell and toCsvRow", () => {
  it("leaves plain cells alone", () => {
    expect(toCsvRow(["id", "did_task", "note"])).toBe("id,did_task,note");
  });

  it("quotes a cell holding the delimiter, a quote, CR or LF, doubling inner quotes", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line one\nline two")).toBe('"line one\nline two"');
    expect(csvCell("cr\ronly")).toBe('"cr\ronly"');
  });

  it("quotes for the delimiter in use only", () => {
    expect(csvCell("a,b", ";")).toBe("a,b");
    expect(csvCell("a;b", ";")).toBe('"a;b"');
    expect(csvCell("a;b", ",")).toBe("a;b");
    expect(toCsvRow(["x", "a;b", "c,d"], ";")).toBe('x;"a;b";c,d');
  });

  it("writes empty, null and undefined as blank, and numbers and booleans as text", () => {
    expect(toCsvRow(["", null, undefined, 3, true])).toBe(",,,3,true");
  });

  it("writes a row of one empty cell as a quoted empty cell, so it isn't a blank line", () => {
    expect(toCsvRow([""])).toBe('""');
  });
});

describe("toCsv", () => {
  it("ends every row with CRLF by default", () => {
    expect(toCsv([["a", "b"], ["c", "d"]])).toBe("a,b\r\nc,d\r\n");
  });

  it("takes another delimiter and line end", () => {
    expect(toCsv([["a", "b;c"]], { delimiter: ";", newline: "\n" })).toBe('a;"b;c"\n');
  });

  it("writes nothing for no rows", () => {
    expect(toCsv([])).toBe("");
  });
});

describe("detectDelimiter", () => {
  it("picks comma or semicolon from the first line", () => {
    expect(detectDelimiter("id,reply,note\n1,2,3")).toBe(",");
    expect(detectDelimiter("id;reply;note\n1,2,3")).toBe(";");
  });

  it("ignores delimiters inside quotes", () => {
    expect(detectDelimiter('"a;b;c;d",x,y\n')).toBe(",");
    expect(detectDelimiter('"a,b,c,d";x;y\n')).toBe(";");
  });

  it("looks past blank lines above the header", () => {
    expect(detectDelimiter("\r\n\nid;note\n")).toBe(";");
  });

  it("looks past a byte-order mark and defaults to comma", () => {
    expect(detectDelimiter("\uFEFFid;note")).toBe(";");
    expect(detectDelimiter("id")).toBe(",");
    expect(detectDelimiter("")).toBe(",");
  });
});

describe("parseCsv", () => {
  it("reads plain rows", () => {
    expect(parseCsv("a,b\nc,d\n")).toEqual({ rows: [["a", "b"], ["c", "d"]], delimiter: "," });
  });

  it("reads quoted cells with line breaks, delimiters and doubled quotes", () => {
    const text = 'id,reply\n1,"COACH: hi\nPERSON: ""fine"", thanks"\n2,plain\n';
    expect(parseCsv(text).rows).toEqual([
      ["id", "reply"],
      ["1", 'COACH: hi\nPERSON: "fine", thanks'],
      ["2", "plain"],
    ]);
  });

  it("reads CRLF line ends, keeping CRLF inside quoted cells", () => {
    expect(parseCsv('a,b\r\n1,"x\r\ny"\r\n').rows).toEqual([
      ["a", "b"],
      ["1", "x\r\ny"],
    ]);
  });

  it("reads lone CR line ends", () => {
    expect(parseCsv("a,b\rc,d").rows).toEqual([["a", "b"], ["c", "d"]]);
  });

  it("drops a byte-order mark, as Excel adds to CSV UTF-8", () => {
    const { rows } = parseCsv("\uFEFFid,did_task\r\nx,Y\r\n");
    expect(rows[0]).toEqual(["id", "did_task"]);
  });

  it("reads what Excel saves with semicolons", () => {
    const text = '\uFEFFid;reply_to_check;did_task\r\nseed:1;"Hello; what\'s next?";Y\r\n';
    expect(parseCsv(text)).toEqual({
      rows: [
        ["id", "reply_to_check", "did_task"],
        ["seed:1", "Hello; what's next?", "Y"],
      ],
      delimiter: ";",
    });
  });

  it("can be told the delimiter", () => {
    expect(parseCsv("a;b,c", ",").rows).toEqual([["a;b", "c"]]);
  });

  it("reads a last row with no line end, and keeps empty cells", () => {
    expect(parseCsv("a,,c\n,,").rows).toEqual([["a", "", "c"], ["", "", ""]]);
  });

  it("keeps a blank line in the middle as a row of one empty cell", () => {
    expect(parseCsv("a\n\nb\n").rows).toEqual([["a"], [""], ["b"]]);
  });

  it("gives no rows for empty text or a lone byte-order mark", () => {
    expect(parseCsv("").rows).toEqual([]);
    expect(parseCsv("\uFEFF").rows).toEqual([]);
  });

  it("keeps a stray quote inside an unquoted cell as written", () => {
    expect(parseCsv('5" screen,ok\n').rows).toEqual([['5" screen', "ok"]]);
  });

  it("reads an unclosed quote to the end instead of throwing", () => {
    expect(parseCsv('a,"never closed\nstill going').rows).toEqual([["a", "never closed\nstill going"]]);
  });

  it("reads a quoted empty cell on its own", () => {
    expect(parseCsv('""').rows).toEqual([[""]]);
  });
});

describe("round trips", () => {
  const tricky = [
    ["id", "conversation_so_far", "reply_to_check", "note"],
    ["run.json:one-word:4", "COACH: What's the plan?\nPERSON: \"Ship it\", by Friday", "Got it; for whom?", ""],
    ["seed:2", "a,b;c", '"quoted"', "trailing space "],
    ["seed:3", "\r\nstarts with a line break", "", "ends with CR\r"],
    [""],
    ["seed:4", "ünïcödé — dash", "'apostrophe", "="],
  ];

  for (const delimiter of [",", ";"] as CsvDelimiter[]) {
    for (const newline of ["\r\n", "\n"]) {
      it(`gives back the same rows with "${delimiter}" and ${JSON.stringify(newline)}`, () => {
        const text = toCsv(tricky, { delimiter, newline });
        expect(parseCsv(text)).toEqual({ rows: tricky, delimiter });
      });
    }
  }

  it("survives a byte-order mark in front", () => {
    expect(parseCsv("\uFEFF" + toCsv(tricky)).rows).toEqual(tricky);
  });
});
