var RGA = require("../lib/rga.js");
//var peeredit = require("../lib/peeredit.js");
var assert = require("assert");

describe("RGA", () => {
  it("can contain text", () => {
    var p = new RGA();
    var cursor = RGA.left;
    cursor = p.addRight(cursor, "h");
    cursor = p.addRight(cursor, "i");
    assert(p.text() === "hi");
  });

  it("can delete text", () => {
    var p = new RGA();
    var c = p.addRight(RGA.left, "c");
    var b = p.addRight(RGA.left, "b");
    var a = p.addRight(RGA.left, "a");
    p.remove(b);
    assert(p.text() === "ac");
    p.remove(a);
    assert(p.text() === "c");
    p.remove(c);
    assert(p.text() === "");
  });

  function type(rga, cursor, text) {
    for (var ch of text)
      cursor = rga.addRight(cursor, ch);
    return cursor;
  }

  // Delete some characters typed by type()
  // where `stop === type(rga, start, text)`.
  // (This code can't delete ranges that contain already-deleted characters.)
  function deleteRange(rga, start, stop) {
    var next;
    for (var cursor = start; cursor !== stop; cursor = next) {
      next = rga.successor(cursor);
      rga.remove(next);
    }
  }

  it("is replicable from history", () => {
    var p = new RGA(1);
    var c = RGA.left;
    c = type(p, c, "good ");
    var d = type(p, c, "bwor");
    deleteRange(p, c, d);
    type(p, c, "morning");
    assert(p.text() === "good morning");

    var q = new RGA(2, p.history());
    assert(q.text() === "good morning");
  });
});
