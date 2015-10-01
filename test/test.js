var RGA = require("../lib/rga.js");
var socketpair = require("../lib/socketpair.js");
var assert = require("assert");
var jsc = require("jsverify");

describe("RGA", () => {
  it("can contain text", () => {
    var p = new RGA(0);
    var cursor = RGA.left.timestamp;
    cursor = p.addRight(cursor, "h");
    cursor = p.addRight(cursor, "i");
    assert.strictEqual(p.text(), "hi");
  });

  it("can delete text", () => {
    var p = new RGA(0);
    var c = p.addRight(RGA.left.timestamp, "c");
    var b = p.addRight(RGA.left.timestamp, "b");
    var a = p.addRight(RGA.left.timestamp, "a");
    p.remove(b);
    assert.strictEqual(p.text(), "ac");
    p.remove(a);
    assert.strictEqual(p.text(), "c");
    p.remove(c);
    assert.strictEqual(p.text(), "");
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
      next = rga.e.get(cursor).timestamp;
      rga.remove(next);
    }
  }

  it("can be replicated from history", () => {
    var p = new RGA(1);
    var c = RGA.left.timestamp;
    c = type(p, c, "good ");
    var d = type(p, c, "bwor");
    deleteRange(p, c, d);
    type(p, c, "morning");
    assert.strictEqual(p.text(), "good morning");

    var q = new RGA(2, p.history());
    assert.strictEqual(q.text(), "good morning");
  });

  it("can be replicated from history even if input is typed backwards", () => {
    var p = new RGA(1);
    for (var c of "olleh")
      p.addRight(RGA.left.timestamp, c);

    var q = new RGA(2, p.history());
    assert.strictEqual(q.text(), "hello");
  });

  function copyWithSockets(main, id) {
    var copy = new RGA(id, main.history());
    var pair = socketpair();
    RGA.tieToSocket(main, pair[0]);
    RGA.tieToSocket(copy, pair[1]);
    return {main: main,
            copy: copy,
            mainToCopy: pair[0],
            copyToMain: pair[1]};
  }

  it("retains deleted items when replicated from history", () => {
    var main = new RGA(0);
    var a = main.addRight(RGA.left.timestamp, "a");
    var b = main.addRight(a, "b");

    var one = copyWithSockets(main, 1);
    var two = copyWithSockets(main, 2);

    main.remove(a);
    main.remove(b);
    assert.strictEqual(main.text(), "");

    for (var i = 0; i < 2; i++)
      one.mainToCopy.deliver("downstream", {type: "remove"});
    assert.strictEqual(one.copy.text(), "");

    // Now test that one.copy knows about the deleted characters from main.
    two.copy.addRight(b, "d");
    two.copy.addRight(a, "c");
    for (var i = 0; i < 2; i++) {
      two.copyToMain.deliver("downstream", {type: "addRight"});
      one.mainToCopy.deliver("downstream", {type: "addRight"});
    }
    assert.strictEqual(main.text(), "cd");
    assert.strictEqual(one.copy.text(), "cd");
  });

  it("sends ops to tied replicas", () => {
    var p = new RGA(1);
    var c = type(p, RGA.left.timestamp, "hi");
    var q = new RGA(2, p.history());
    RGA.tie(p, q);

    var c2 = type(p, c, " there");
    assert.strictEqual(q.text(), "hi there");
    type(q, c2, " kaitlin");
    assert.strictEqual(p.text(), "hi there kaitlin");
    deleteRange(q, c, c2);
    assert.strictEqual(p.text(), "hi kaitlin");
  });

  it("doesn't generate bogus timestamps", () => {
    var p = new RGA(0);
    var q = new RGA(1);
    RGA.tie(p, q);
    var c = q.addRight(RGA.left.timestamp, "A");
    assert.strictEqual(q.text(), "A");
    assert.strictEqual(p.text(), "A");
    var d = p.addRight(RGA.left.timestamp, "B");
    assert.strictEqual(p.text(), "BA");
    assert.strictEqual(q.text(), "BA");
  });

  it("can replicate across a chain of intermediate replicas", () => {
    var replicas = [new RGA(0)];
    var N = 50;
    for (var i = 1; i < N; i++) {
      replicas[i] = new RGA(i);
      RGA.tie(replicas[i - 1], replicas[i]);
    }
    type(replicas[N-1], RGA.left.timestamp, "A");
    assert(replicas.every(r => r.text() === "A"));
    type(replicas[0], RGA.left.timestamp, "Z");
    assert(replicas.every(r => r.text() === "ZA"));
  });

  describe("tieToSocket", () => {
    it("works with socketpair", () => {
      var pair = socketpair();
      var a = pair[0], b = pair[1];
      var p = new RGA(0), q = new RGA(1);
      RGA.tieToSocket(p, a);
      RGA.tieToSocket(q, b);

      p.addRight(RGA.left.timestamp, "Q");
      assert.strictEqual(q.text(), "");  // not delivered yet
      a.deliver("downstream", {
        type: "addRight",
        w: {atom: "Q"}
      });
      assert.strictEqual(q.text(), "Q");
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
        var len = jsc.random(0, 30), pRemove = jsc.random.number(0, 1);
        var timestamps = [];
        for (var i = 0; i < len; i++)
          timestamps[i] = i;

        var prev = RGA.left.timestamp;
        var h = new RGA(0);
        for (var i = 0; i < len; i++) {
          var tIndex = jsc.random(0, timestamps.length - 1);
          var t = timestamps[tIndex];
          timestamps[tIndex] = timestamps[timestamps.length - 1];
          timestamps.length--;

          var w = {atom: arbitraryChar.generator(), timestamp: t};
          h._downstream(h.downstream, {type: "addRight", t: prev, w: w});
          if (jsc.random.number(0, 1) < pRemove)
            h._downstream(h.downstream, {type: "remove", t: t});
          prev = t;
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
      type(p, RGA.left.timestamp, "abcdefg");
      p.removeRowColumn(p, 0, 0, 3);
      assert.strictEqual(p.text(), "defg");
    });

    it("can remove text at the end of the array", () => {
      var p = new RGA(0);
      type(p, RGA.left.timestamp, "hi\nthere\nyou kid");
      p.removeRowColumn(p, 2, 3, 4);
      assert.strictEqual(p.text(), "hi\nthere\nyou");
    });

    it("can remove everything from the array", () => {
      var p = new RGA(0);
      type(p, RGA.left.timestamp, "good morning, how are\nyou today?");
      p.removeRowColumn(p, 0, 0, p.text().length);
      assert.strictEqual(p.text(), "");
    });

    it("can remove characters when some characters have already been removed", () => {
      var p = new RGA(0);
      type(p, RGA.left.timestamp, "abcdefg");
      p.removeRowColumn(p, 0, 3, 1);
      assert.strictEqual(p.text(), "abcefg");
      p.removeRowColumn(p, 0, 2, 2);
      assert.strictEqual(p.text(), "abfg");
      p.removeRowColumn(p, 0, 0, 4);
      assert.strictEqual(p.text(), "");
    });
  });
});
