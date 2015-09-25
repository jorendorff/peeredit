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

  it("sends ops to tied replicas", () => {
    var p = new RGA(1);
    var c = type(p, RGA.left, "hi");
    var q = new RGA(2, p.history());
    RGA.tie(p, q);

    var c2 = type(p, c, " there");
    assert(q.text() === "hi there");
    type(q, c2, " kaitlin");
    assert(p.text() === "hi there kaitlin");
    deleteRange(q, c, c2);
    assert(p.text() === "hi kaitlin");
  });

  it("doesn't generate bogus timestamps", () => {
    var p = new RGA(0);
    var q = new RGA(1);
    RGA.tie(p, q);
    var c = q.addRight(RGA.left, "A");
    assert(q.text() === "A");
    assert(p.text() === "A");
    var d = p.addRight(RGA.left, "B");
    assert(p.text() === "BA");
    assert(q.text() === "BA");
  });

  it("can replicate across a chain of intermediate replicas", () => {
    var replicas = [new RGA(0)];
    var N = 50;
    for (var i = 1; i < N; i++) {
      replicas[i] = new RGA(i);
      RGA.tie(replicas[i - 1], replicas[i]);
    }
    type(replicas[N-1], RGA.left, "A");
    assert(replicas.every(r => r.text() === "A"));
    type(replicas[0], RGA.left, "Z");
    assert(replicas.every(r => r.text() === "ZA"));
  });

  //describe("socket.io support", () => {
  //});
});
