// -*- mode: javascript; js-indent-level: 2 -*-

"use strict";

var RGA = require("../lib/rga.js");
var testsupport = require("../lib/testsupport.js");
var socketpair = testsupport.socketpair;
var MockEventQueue = testsupport.MockEventQueue;
var assert = require("assert");

class MockAceEditor {
  constructor(queue) {
    this._lines = [""]
    this._subscribers = [];
    this._queue = queue || new MockEventQueue;
  }

  getSession() { return this; }
  getDocument() { return this; }

  getValue() {
    return this._lines.join("\n");
  }

  setValue(text) {
    // Note: _lines is never an empty array; even if `text` is an empty string,
    // text.split(/\n/g) returns [""].
    this._lines = text.split(/\n/g);
    this._enqueueChangeEvent();
  }

  getLine(n) {
    return this._lines[n];
  }

  on(event, callback) {
    if (event === "change")
      this._subscribers.push(callback);
  }

  off(event, callback) {
    if (event === "change") {
      var i = this._subscribers.indexOf(callback);
      if (i !== -1)
        this._subscribers.splice(i, 1);
    }
  }

  _enqueueChangeEvent() {
    for (let cb of this._subscribers) {
      this._queue.defer(() => cb.apply(undefined, arguments));
    }
  }

  _deliverCallbacks() {
    this._queue.drain();
  }
  
  insert(loc, s) {
    let row = loc.row, column = loc.column;
    let line = this._lines[row] || "";
    let edited = line.slice(0, column) + s + line.slice(column);
    let args = [row, 1].concat(edited.split(/\n/g));
    this._lines.splice.apply(this._lines, args);
    this._enqueueChangeEvent();
  }

  remove(span) {
    let start = span.start, end = span.end;
    let preStart = this._lines[start.row].slice(0, start.column);
    let endLine = this._lines[end.row] || "";
    let postEnd = endLine.slice(end.column, endLine.length);
    this._lines.splice(start.row, end.row - start.row + 1, preStart + postEnd);
    this._enqueueChangeEvent();
  }
}

describe("RGA.tieToAceEditor", () => {
  it("propagates inserts from the RGA to the editor", () => {
    let q = new MockEventQueue;
    let e = new MockAceEditor(q);
    let a = new RGA(0, undefined, q);
    RGA.tieToAceEditor(a, e, q);
    var cursor = a.left.timestamp;
    cursor = a.addRight(cursor, "h");
    cursor = a.addRight(cursor, "i");
    q.drain();
    assert.strictEqual(e.getValue(), "hi");
  });

  it("clobbers the previous editor state", () => {
    let q = new MockEventQueue;
    let e = new MockAceEditor(q);
    e.setValue("one\ntwo\nthree\n");
    let p = new RGA(0, undefined, q);
    let cursor = p.left.timestamp;
    cursor = p.addRight(cursor, "X");
    cursor = p.addRight(cursor, "\n");
    cursor = p.addRight(cursor, "Y");
    cursor = p.addRight(cursor, "\n");
    cursor = p.addRight(cursor, "Z");
    cursor = p.addRight(cursor, "Z");
    RGA.tieToAceEditor(p, e, q);
    assert.strictEqual(e.getValue(), "X\nY\nZZ");
  });

  it("propagates deletes from the RGA to the editor", () => {
    let q = new MockEventQueue;
    let e = new MockAceEditor(q);
    let p = new RGA(0, undefined, q);
    RGA.tieToAceEditor(p, e, q);
    var c = p.addRight(p.left.timestamp, "c");
    var b = p.addRight(p.left.timestamp, "b");
    var a = p.addRight(p.left.timestamp, "a");
    q.drain();

    p.remove(b);
    q.drain();
    assert.strictEqual(e.getValue(), "ac");

    p.remove(a);
    q.drain();
    assert.strictEqual(e.getValue(), "c");

    p.remove(c);
    q.drain();
    assert.strictEqual(e.getValue(), "");
  });

  it("propagates inserts from the editor to the RGA", () => {
    let q = new MockEventQueue;
    let e = new MockAceEditor(q);
    let p = new RGA(0, undefined, q);
    RGA.tieToAceEditor(p, e, q);

    e.insert({row: 0, column: 0}, "hello");
    q.drain();
    assert.strictEqual(p.text(), "hello");

    e.insert({row: 0, column: 0}, "\n");
    q.drain();
    assert.strictEqual(p.text(), "\nhello");

    e.insert({row: 1, column: 4}, "iqu");
    q.drain();
    assert.strictEqual(p.text(), "\nhelliquo");

    e.insert({row: 0, column: 0}, "hi!");
    q.drain();
    assert.strictEqual(p.text(), "hi!\nhelliquo");
  });

  it("propagates deletes from the editor to the RGA", () => {
    let q = new MockEventQueue;
    let e = new MockAceEditor(q);
    let p = new RGA(0, undefined, q);
    p.addRight(p.left.timestamp, "c");
    p.addRight(p.left.timestamp, "b");
    p.addRight(p.left.timestamp, "a");
    RGA.tieToAceEditor(p, e, q);
    assert.strictEqual(e._subscribers.length, 1);

    e.remove({start: {row: 0, column: 1}, end: {row: 0, column: 2}});
    assert.strictEqual(e.getValue(), "ac");
    assert.strictEqual(p.text(), "abc");
    assert.strictEqual(q._queue.length, 1);
    q.drain();
    assert.strictEqual(p.text(), "ac");

    e.remove({start: {row: 0, column: 0}, end: {row: 0, column: 1}});
    q.drain();
    assert.strictEqual(p.text(), "c");

    e.remove({start: {row: 0, column: 0}, end: {row: 0, column: 1}});
    q.drain();
    assert.strictEqual(p.text(), "");
  });

  it("can cope with editor updates being received slowly", () => {
    let eq = new MockEventQueue;
    let e = new MockAceEditor(eq);
    let pq = new MockEventQueue;
    let p = new RGA(0, undefined, pq);
    let cursor = p.left.timestamp;
    let space;
    "HOME RUN".split(/(?:)/g).forEach(ch => {
      cursor = p.addRight(cursor, ch);
      if (ch == " ")
        space = cursor;
    });
    RGA.tieToAceEditor(p, e, eq);
    assert.strictEqual(e.getValue(), "HOME RUN");

    // A character is deleted, using the editor. Note that we'll be out of
    // sync until the edit event is delivered from e to p.
    e.remove({start: {row: 0, column: 4}, end: {row: 0, column: 5}});
    assert.strictEqual(e.getValue(), "HOMERUN");
    assert.strictEqual(p.text(), "HOME RUN");

    // Racing with that change, an edit comes in to the RGA.  This forces the
    // editor state to be reconciled (via diffing), even though we still
    // haven't delivered the edit event yet.
    p.addRight(space, "*");
    pq.drain();  // deliver p's event but not e's
    assert.strictEqual(e.getValue(), "HOME*RUN");
    assert.strictEqual(p.text(), "HOME*RUN");

    // Delivering the edit event then has no effect, since we already handled
    // that edit.
    eq.drain();
    assert.strictEqual(e.getValue(), "HOME*RUN");
    assert.strictEqual(p.text(), "HOME*RUN");
  });
});
