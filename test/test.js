var RGA = require("../lib/rga.js");
var socketpair = require("../lib/socketpair.js");
var assert = require("assert");
var jsc = require("jsverify");

describe("RGA", () => {
  it("can contain text", () => {
    var p = new RGA(0);
    var cursor = RGA.left;
    cursor = p.addRight(cursor, "h");
    cursor = p.addRight(cursor, "i");
    assert(p.text() === "hi");
  });

  it("can delete text", () => {
    var p = new RGA(0);
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

  it("retains deleted items when replicated from history", () => {
    var p = new RGA(1);
    var a = p.addRight(RGA.left, "a");
    var b = p.addRight(a, "b");
    var other = new RGA(3, p.history());
    p.remove(a);
    p.remove(b);
    assert.strictEqual(p.text(), "");

    var q = new RGA(2, p.history());
    assert.strictEqual(q.text(), "");

    // Whitebox-test that q knows about the deleted characters from p.
    q._downstream(other, {type: "addRight", u: a, w: {atom: "c", timestamp: a.atom + 2}});
    q._downstream(other, {type: "addRight", u: b, w: {atom: "d", timestamp: b.atom + 2}});
    assert.strictEqual(q.text(), "cd");
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

    var arbitraryChar = jsc.elements(['a', 'b', 'c', 'X', 'Y', 'Z', '0', '\n', ' ', '\u1234']);
    var arbitraryStr = jsc.elements(['', 'xyzzy', 'hello\nworld\n', '\n\n\n\n', '\nok',
                                     Array(16).join("wat" - 1) + " Batman!"]);

    var arbitraryRGA = jsc.bless({
      generator: function () {
        var len = jsc.random(0, 30), pRemove = Math.random();
        var timestamps = [];
        for (var i = 0; i < len; i++)
          timestamps[i] = i;

        var prev = RGA.left;
        var h = new RGA(0);
        for (var i = 0; i < len; i++) {
          var tIndex = jsc.random(0, timestamps.length - 1);
          var t = timestamps[tIndex];
          timestamps[tIndex] = timestamps[timestamps.length - 1];
          timestamps.length--;

          var w = {atom: arbitraryChar.generator(), timestamp: t};
          h._downstream(h, {type: "addRight", u: prev, w: w});
          if (Math.random() < pRemove)
            h._downstream(h, {type: "remove", w: w});
          prev = w;
        }
        return h;
      }
    });

    function randomPositionIn(str) {
      var offset = jsc.random(0, str.length);  // note: inclusive of str.length
      var lines = str.slice(0, offset).split("\n");
      var row = lines.length - 1;
      return {
        offset: offset,
        row: row,
        column: lines[row].length
      };
    }

    var arbitraryTestCase = jsc.bless({
      generator: function () {
        var a = arbitraryRGA.generator();
        var text = a.text();
        return {
          history: a.history(),
          text: text,
          loc: randomPositionIn(text),
          insert: arbitraryStr.generator()
        };
      }
    });

    jsc.property("inserts text (in random test cases)", arbitraryTestCase, testCase => {
      var p = new RGA(0, testCase.history);
      p.insertRowColumn(p, testCase.loc.row, testCase.loc.column, testCase.insert);
      var text = testCase.text;
      var offset = testCase.loc.offset;
      return p.text() === text.slice(0, offset) + testCase.insert + text.slice(offset);
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
