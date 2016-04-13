// -*- mode: javascript; js-indent-level: 2 -*-
//
// testsupport.js - Things to help test the stuff in rga.js.

"use strict";

var assert = require("assert");

// A dummy implementation of a subset of socket.io where messages are not
// delivered until you explicitly order the socket to deliver them.
//
// socketpair() returns a pair of sockets that don't actually send messages to one another
// until you insist on it.
//
// socketpair() returns a pair [a, b] of ReluctantSocket objects. The API these
// objects provide is analogous to a subset of what socket.io provides. There's
// no Server object, no connection event. Instead these sockets are presented
// as though they're already connected. `a.on(tag, callback)` works like in
// socket.io.
//
// `b.emit(tag, ...args)` buffers the message until you do
// `b.deliver(tag, ...args)`. That then delivers the message to a, firing a's
// callbacks. Note that `deliver` has to be called on the socket where `emit`
// was called: messages are buffered at the sending end.
//
// `b.deliverNext()` delivers the next queued message, whatever it is.
//
function socketpair() {
  var a = new ReluctantSocket();
  var b = new ReluctantSocket();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

// Return true if `actual` has all the (enumerable) properties that `expected`
// has. (The values must match too. `actual` may also have properties not
// specified in `expected`; they're ignored.)
function hasProperties(actual, expected) {
  for (var k in expected) {
    var v = expected[k];
    if (!(k in actual))
      return false;
    if (Object(v) === v) {
      if (!hasProperties(actual[k], v))
        return false;
    } else {
      if (actual[k] !== v)
        return false;
    }
  }
  return true;
}

function assertHasProperties(actual, expected) {
  assert.strictEqual(Object(actual), actual);
  if (!hasProperties(actual, expected)) {
    //console.log("got:", actual, " expected:", expected);
    assert.fail(actual, expected, "assertHasProperties failed", "!~~");
  }
}

// A fake socket that's less reluctant than ReluctantSocket.
// This one needs no encouragement to let the queue deliver events.
class MockSocket {
  constructor(queue) {
    this.peer = undefined;
    this.subscribers = Object.create(null);
    this.queue = queue;
  }

  on(tag, callback) {
    if (!(tag in this.subscribers))
      this.subscribers[tag] = [];
    this.subscribers[tag].push(callback);
  }

  emit(tag) {
    var args = [].slice.call(arguments, 1);
    console.log("MockSocket.emit:", tag, args);
    this.queue.defer(() => {
      console.log("socket is delivering the event:", tag, args);
      this.peer._deliver(tag, args);
    });
  }

  _deliver(tag, args) {
    var recipients = this.subscribers[tag];
    if (recipients !== undefined) {
      recipients.forEach(r => {
        console.log("actually firing event:", tag, args);
        this.queue.defer(() => r.apply(undefined, args))
      });
    }
  }

  static pair(queue) {
    var a = new this(queue);
    var b = new this(queue);
    a.peer = b;
    b.peer = a;
    return [a, b];
  }
}

class ReluctantSocket {
  constructor() {
    this.peer = undefined;
    this.buffer = [];
    this.subscribers = Object.create(null);
  }

  on(tag, callback) {
    if (!(tag in this.subscribers))
      this.subscribers[tag] = [];
    this.subscribers[tag].push(callback);
  }

  emit() {
    this.buffer.push(arguments);
  }

  deliver() {
    var actual = this.buffer[0];
    assert.notStrictEqual(actual, undefined);
    var expected = arguments;
    assert.strictEqual(actual.length, expected.length);
    assertHasProperties(actual, expected);
    this.deliverNext();
  }

  deliverNext() {
    let msg = this.buffer.shift();

    var s = this.peer.subscribers[msg[0]];
    if (s !== undefined) {
      s.forEach(c => {
        c.apply(undefined, [].slice.call(msg, 1));
      });
    }
  }
}

class MockEventQueue {
  constructor() {
    this._queue = [];
  }

  defer(cb) {
    this._queue.push(cb);
  }

  drain() {
    while (this._queue.length > 0)
      this._queue.shift()();
  }
}

module.exports = exports = {
  socketpair: socketpair,
  MockEventQueue: MockEventQueue,
  MockSocket: MockSocket
};
