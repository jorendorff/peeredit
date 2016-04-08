// -*- mode: javascript; js-indent-level: 2 -*-

"use strict";

var RGA = require("../lib/rga.js");
var socketpair = require("../lib/socketpair.js");
var assert = require("assert");

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

class MockAceEditor {
  constructor() {
    this._lines = [""]
    this._subscribers = [];
    this._queue = new MockEventQueue;
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
    let e = new MockAceEditor();
    let p = new RGA(0);
    RGA.tieToAceEditor(p, e);
    var cursor = p.left.timestamp;
    cursor = p.addRight(cursor, "h");
    cursor = p.addRight(cursor, "i");
    assert.strictEqual(e.getValue(), "hi");
  });

  it("clobbers the previous editor state", () => {
    let e = new MockAceEditor();
    e.setValue("one\ntwo\nthree\n");
    let p = new RGA(0);
    let cursor = p.left.timestamp;
    cursor = p.addRight(cursor, "X");
    cursor = p.addRight(cursor, "\n");
    cursor = p.addRight(cursor, "Y");
    cursor = p.addRight(cursor, "\n");
    cursor = p.addRight(cursor, "Z");
    cursor = p.addRight(cursor, "Z");
    RGA.tieToAceEditor(p, e);
    assert.strictEqual(e.getValue(), "X\nY\nZZ");
  });

  it("propagates deletes from the RGA to the editor", () => {
    let e = new MockAceEditor();
    let p = new RGA(0);
    RGA.tieToAceEditor(p, e);
    var c = p.addRight(p.left.timestamp, "c");
    var b = p.addRight(p.left.timestamp, "b");
    var a = p.addRight(p.left.timestamp, "a");
    p.remove(b);
    assert.strictEqual(e.getValue(), "ac");
    p.remove(a);
    assert.strictEqual(e.getValue(), "c");
    p.remove(c);
    assert.strictEqual(e.getValue(), "");
  });

  it("propagates inserts from the editor to the RGA", () => {
    let e = new MockAceEditor();
    let p = new RGA(0);
    RGA.tieToAceEditor(p, e);
    e.insert({row: 0, column: 0}, "hello");
    e._deliverCallbacks();
    assert.strictEqual(p.text(), "hello");
    e.insert({row: 0, column: 0}, "\n");
    e._deliverCallbacks();
    assert.strictEqual(p.text(), "\nhello");
    e.insert({row: 1, column: 4}, "iqu");
    e._deliverCallbacks();
    assert.strictEqual(p.text(), "\nhelliquo");
    e.insert({row: 0, column: 0}, "hi!");
    e._deliverCallbacks();
    assert.strictEqual(p.text(), "hi!\nhelliquo");
  });

  it("propagates deletes from the editor to the RGA", () => {
    let e = new MockAceEditor();
    let p = new RGA(0);
    p.addRight(p.left.timestamp, "c");
    p.addRight(p.left.timestamp, "b");
    p.addRight(p.left.timestamp, "a");
    RGA.tieToAceEditor(p, e);

    e.remove({start: {row: 0, column: 1}, end: {row: 0, column: 2}});
    e._deliverCallbacks();
    assert.strictEqual(p.text(), "ac");

    e.remove({start: {row: 0, column: 0}, end: {row: 0, column: 1}});
    e._deliverCallbacks();
    assert.strictEqual(p.text(), "c");

    e.remove({start: {row: 0, column: 0}, end: {row: 0, column: 1}});
    e._deliverCallbacks();
    assert.strictEqual(p.text(), "");
  });

  it("can cope with editor updates being received slowly", () => {
    let e = new MockAceEditor();
    let p = new RGA(0);
    let cursor = p.left.timestamp;
    let space;
    "HOME RUN".split(/(?:)/g).forEach(ch => {
      cursor = p.addRight(cursor, ch);
      if (ch == " ")
        space = cursor;
    });
    RGA.tieToAceEditor(p, e);
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
    assert.strictEqual(e.getValue(), "HOME*RUN");
    assert.strictEqual(p.text(), "HOME*RUN");

    // Delivering the edit event then has no effect, since we already handled
    // that edit.
    e._deliverCallbacks();
    assert.strictEqual(e.getValue(), "HOME*RUN");
    assert.strictEqual(p.text(), "HOME*RUN");
  });
});
