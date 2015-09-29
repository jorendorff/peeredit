var RGA = require("../lib/rga.js");
var socketpair = require("../lib/socketpair.js");
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

  it("can be replicated from history", () => {
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

  it("can be replicated from history even if input is typed backwards", () => {
    var p = new RGA(1);
    for (var c of "olleh")
      p.addRight(RGA.left, c);

    var q = new RGA(2, p.history());
    assert(q.text() === "hello");
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

  describe("tieToSocket", () => {
    it("works with socketpair", () => {
      var pair = socketpair();
      var a = pair[0], b = pair[1];
      var p = new RGA(0), q = new RGA(1);
      RGA.tieToSocket(p, a);
      RGA.tieToSocket(q, b);

      p.addRight(RGA.left, "Q");
      assert(q.text() === "");  // not delivered yet
      a.deliver("downstream", {
        type: "addRight",
        w: {atom: "Q"}
      });
      assert(q.text() === "Q");
    });

    it("cleans up after itself when a socket disconnects", () => {
      var pair = socketpair(), a = pair[0], b = pair[1];
      var p = new RGA(0), q = new RGA(1);
      RGA.tieToSocket(p, a);
      RGA.tieToSocket(q, b);
      a.emit("disconnect");
      a.deliver("disconnect");
      assert.strictEqual(q._subscribers.length, 0);
      assert.strictEqual(p._subscribers.length, 1);
      b.emit("disconnect");
      b.deliver("disconnect");
      assert.strictEqual(p._subscribers.length, 0);
    });
  });

  describe("insertRowColumn", () => {
    it("inserts text", () => {
      var p = new RGA(0);
      p.insertRowColumn(p, 0, 0, "hello world\n");
      assert.strictEqual(p.text(), "hello world\n");
      p.insertRowColumn(p, 0, 0, "## ");
      assert.strictEqual(p.text(), "## hello world\n");
      p.insertRowColumn(p, 1, 0, "\nThis program prints a greeting to stdout.\n\n" +
                        "    print 'hello'\n");
      assert.strictEqual(p.text(), "## hello world\n\n" +
                         "This program prints a greeting to stdout.\n\n" +
                         "    print 'hello'\n");
      p.insertRowColumn(p, 4, 16, " world");
      assert.strictEqual(p.text(), "## hello world\n\n" +
                         "This program prints a greeting to stdout.\n\n" +
                         "    print 'hello world'\n");
    });

    it("can get row and column numbers right even after deletions", () => {
      var p = new RGA(0);
      p.insertRowColumn(p, 0, 0, "ab1234ch");
      p.removeRowColumn(p, 0, 2, 4);
      p.insertRowColumn(p, 0, 3, "defg");
      assert.strictEqual(p.text(), "abcdefgh");
      p.insertRowColumn(p, 0, 8, "\n1234567\n89\nijkqrs");
      p.removeRowColumn(p, 0, 8, 12);
      p.insertRowColumn(p, 0, 11, "lmnop");
      assert.strictEqual(p.text(), "abcdefghijklmnopqrs");
    });
  });

  describe("removeRowColumn", () => {
    it("can remove text at the beginning of the array", () => {
      var p = new RGA(0);
      type(p, RGA.left, "abcdefg");
      p.removeRowColumn(p, 0, 0, 3);
      assert.strictEqual(p.text(), "defg");
    });

    it("can remove text at the end of the array", () => {
      var p = new RGA(0);
      type(p, RGA.left, "hi\nthere\nyou kid");
      p.removeRowColumn(p, 2, 3, 4);
      assert.strictEqual(p.text(), "hi\nthere\nyou");
    });

    it("can remove everything from the array", () => {
      var p = new RGA(0);
      type(p, RGA.left, "good morning, how are\nyou today?");
      p.removeRowColumn(p, 0, 0, p.text().length);
      assert.strictEqual(p.text(), "");
    });

    it("can remove characters when some characters have already been removed", () => {
      var p = new RGA(0);
      type(p, RGA.left, "abcdefg");
      p.removeRowColumn(p, 0, 3, 1);
      assert.strictEqual(p.text(), "abcefg");
      p.removeRowColumn(p, 0, 2, 2);
      assert.strictEqual(p.text(), "abfg");
      p.removeRowColumn(p, 0, 0, 4);
      assert.strictEqual(p.text(), "");
    });
  });
});
