// -*- mode: javascript; js-indent-level: 2 -*-

var RGA = require("../lib/rga.js");
var testsupport = require("../lib/testsupport.js");
var socketpair = testsupport.socketpair;
var MockEventQueue = testsupport.MockEventQueue;
var assert = require("assert");
var jsc = require("jsverify");

describe("RGA", () => {
  it("can contain text", () => {
    var p = new RGA(0);
    var cursor = p.left.timestamp;
    cursor = p.addRight(cursor, "h");
    cursor = p.addRight(cursor, "i");
    assert.strictEqual(p.text(), "hi");
  });

  it("can delete text", () => {
    var p = new RGA(0);
    var c = p.addRight(p.left.timestamp, "c");
    var b = p.addRight(p.left.timestamp, "b");
    var a = p.addRight(p.left.timestamp, "a");
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
  function deleteRange(rga, start, stop) {
    for (var node = rga._index.get(start); node.timestamp !== stop; node = node.next) {
      if (!node.next.removed)
        rga.remove(node.next.timestamp);
    }
  }

  it("can be replicated from history", () => {
    var p = new RGA(1);
    var c = p.left.timestamp;
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
      p.addRight(p.left.timestamp, c);

    var q = new RGA(2, p.history());
    assert.strictEqual(q.text(), "hello");
  });

  function copyWithSockets(main, id, queue) {
    var copy = new RGA(id, main.history(), queue);
    var pair = socketpair();
    RGA.tieToSocket(main, pair[0]);
    RGA.tieToSocket(copy, pair[1]);
    return {main: main,
            copy: copy,
            mainToCopy: pair[0],
            copyToMain: pair[1]};
  }

  it("can cope with items deleted in separate replicas at the same time", () => {
    var q = new MockEventQueue();
    var a = new RGA(0, undefined, q);
    var cursor = a.left.timestamp;
    for (var c of "griin") {
      var p = a.addRight(cursor, c);
      if (c != 'n')
        cursor = p;
    }

    var b = new RGA(1, a.history(), q);
    RGA.tie(a, b);
    a.remove(cursor);
    b.remove(cursor);
    q.drain();
    assert.strictEqual(a.text(), "grin");
    assert.strictEqual(b.text(), "grin");
  });

  it("retains deleted items when replicated from history", () => {
    var queue = new MockEventQueue();
    var main = new RGA(0, undefined, queue);
    var a = main.addRight(main.left.timestamp, "a");
    var b = main.addRight(a, "b");

    var one = copyWithSockets(main, 1, queue);
    var two = copyWithSockets(main, 2, queue);

    main.remove(a);
    queue.drain();
    main.remove(b);
    queue.drain();
    assert.strictEqual(main.text(), "");

    for (var i = 0; i < 2; i++)
      one.mainToCopy.deliver("downstream", {type: "remove"});
    queue.drain();
    assert.strictEqual(one.copy.text(), "");

    // Now test that one.copy knows about the deleted characters from main.
    two.copy.addRight(b, "d");
    two.copy.addRight(a, "c");
    queue.drain();
    for (var i = 0; i < 2; i++) {
      two.copyToMain.deliver("downstream", {type: "addRight"});
      queue.drain();
      one.mainToCopy.deliver("downstream", {type: "addRight"});
      queue.drain();
    }
    assert.strictEqual(main.text(), "cd");
    assert.strictEqual(one.copy.text(), "cd");
  });

  it("sends ops to tied replicas", () => {
    var queue = new MockEventQueue();
    var p = new RGA(1, undefined, queue);
    var c = type(p, p.left.timestamp, "hi");
    var q = new RGA(2, p.history(), queue);
    RGA.tie(p, q);

    var c2 = type(p, c, " there");
    queue.drain();
    assert.strictEqual(q.text(), "hi there");

    type(q, c2, " kaitlin");
    queue.drain();
    assert.strictEqual(p.text(), "hi there kaitlin");

    deleteRange(q, c, c2);
    queue.drain();
    assert.strictEqual(p.text(), "hi kaitlin");
  });

  it("doesn't generate bogus timestamps", () => {
    var queue = new MockEventQueue();
    var p = new RGA(0, undefined, queue);
    var q = new RGA(1, undefined, queue);
    RGA.tie(p, q);

    var c = q.addRight(q.left.timestamp, "A");
    queue.drain();
    assert.strictEqual(q.text(), "A");
    assert.strictEqual(p.text(), "A");

    var d = p.addRight(p.left.timestamp, "B");
    queue.drain();
    assert.strictEqual(p.text(), "BA");
    assert.strictEqual(q.text(), "BA");
  });

  it("can replicate across a chain of intermediate replicas", () => {
    var queue = new MockEventQueue();
    var replicas = [new RGA(0, undefined, queue)];
    var N = 50;
    for (var i = 1; i < N; i++) {
      replicas[i] = new RGA(i, undefined, queue);
      RGA.tie(replicas[i - 1], replicas[i]);
    }

    type(replicas[N-1], replicas[N-1].left.timestamp, "A");
    queue.drain();
    assert(replicas.every(r => r.text() === "A"));

    type(replicas[0], replicas[0].left.timestamp, "Z");
    queue.drain();
    assert(replicas.every(r => r.text() === "ZA"));
  });

  describe("tieToSocket", () => {
    it("works with socketpair", () => {
      var queue = new MockEventQueue();
      var pair = socketpair();
      var a = pair[0], b = pair[1];
      var p = new RGA(0, undefined, queue);
      var q = new RGA(1, undefined, queue);
      RGA.tieToSocket(p, a);
      RGA.tieToSocket(q, b);

      p.addRight(p.left.timestamp, "Q");
      queue.drain();
      assert.strictEqual(q.text(), "");  // not delivered yet

      a.deliver("downstream", {
        type: "addRight",
        w: {atom: "Q"}
      });
      queue.drain();
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
});
