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

describe("RGA.AceEditorRGA", () => {
  it("propagates inserts from the RGA to the editor", () => {
    let q = new MockEventQueue;
    let e = new RGA.AceEditorRGA(0, new MockAceEditor(q));
    let a = new RGA(1, undefined, q);
    RGA.tie(a, e);
    var cursor = a.left.timestamp;
    cursor = a.addRight(cursor, "h");
    cursor = a.addRight(cursor, "i");
    q.drain();
    assert.strictEqual(e.editor.getValue(), "hi");
  });

  it("clobbers the previous editor state", () => {
    let q = new MockEventQueue;
    let editor = new MockAceEditor(q);
    editor.setValue("one\ntwo\nthree\n");

    let p = new RGA(0, undefined, q);
    let cursor = p.left.timestamp;
    cursor = p.addRight(cursor, "X");
    cursor = p.addRight(cursor, "\n");
    cursor = p.addRight(cursor, "Y");
    cursor = p.addRight(cursor, "\n");
    cursor = p.addRight(cursor, "Z");
    cursor = p.addRight(cursor, "Z");

    let e = new RGA.AceEditorRGA(1, editor, p.history(), q);
    assert.strictEqual(editor.getValue(), "X\nY\nZZ");
  });

  it("propagates deletes from the RGA to the editor", () => {
    let q = new MockEventQueue;
    let x = new RGA(1, undefined, q);
    let y = new RGA.AceEditorRGA(0, new MockAceEditor(q), undefined, q);
    RGA.tie(x, y);
    var c = x.addRight(x.left.timestamp, "c");
    var b = x.addRight(x.left.timestamp, "b");
    var a = x.addRight(x.left.timestamp, "a");
    q.drain();
    assert.strictEqual(y.editor.getValue(), "abc");

    x.remove(b);
    q.drain();
    assert.strictEqual(y.editor.getValue(), "ac");

    x.remove(a);
    q.drain();
    assert.strictEqual(y.editor.getValue(), "c");

    x.remove(c);
    q.drain();
    assert.strictEqual(y.editor.getValue(), "");
  });

  it("propagates inserts from the editor to the RGA", () => {
    let q = new MockEventQueue;
    let editor = new MockAceEditor(q);
    let x = new RGA.AceEditorRGA(1, editor, undefined, q);
    let y = new RGA(0, undefined, q);
    RGA.tie(x, y);

    editor.insert({row: 0, column: 0}, "hello");
    q.drain();
    assert.strictEqual(x.text(), "hello");
    assert.strictEqual(y.text(), "hello");

    editor.insert({row: 0, column: 0}, "\n");
    q.drain();
    assert.strictEqual(x.text(), "\nhello");
    assert.strictEqual(y.text(), "\nhello");

    editor.insert({row: 1, column: 4}, "iqu");
    q.drain();
    assert.strictEqual(x.text(), "\nhelliquo");
    assert.strictEqual(y.text(), "\nhelliquo");

    editor.insert({row: 0, column: 0}, "hi!");
    q.drain();
    assert.strictEqual(x.text(), "hi!\nhelliquo");
    assert.strictEqual(y.text(), "hi!\nhelliquo");
  });

  it("propagates deletes from the editor to the RGA", () => {
    let q = new MockEventQueue;
    let editor = new MockAceEditor(q);
    let x = new RGA.AceEditorRGA(0, editor, undefined, q);
    let y = new RGA(1, undefined, q);
    RGA.tie(x, y);

    y.addRight(y.left.timestamp, "c");
    y.addRight(y.left.timestamp, "b");
    y.addRight(y.left.timestamp, "a");
    assert.strictEqual(y.text(), "abc");
    q.drain();

    editor.remove({start: {row: 0, column: 1}, end: {row: 0, column: 2}});
    q.drain();
    assert.strictEqual(y.text(), "ac");

    editor.remove({start: {row: 0, column: 0}, end: {row: 0, column: 1}});
    q.drain();
    assert.strictEqual(y.text(), "c");

    editor.remove({start: {row: 0, column: 0}, end: {row: 0, column: 1}});
    q.drain();
    assert.strictEqual(y.text(), "");
  });

  it("can cope with editor updates being received slowly", () => {
    let q = new MockEventQueue;
    let x = new RGA(0, undefined, q);
    let cursor = x.left.timestamp;
    let space;
    "HOME RUN".split(/(?:)/g).forEach(ch => {
      cursor = x.addRight(cursor, ch);
      if (ch == " ")
        space = cursor;
    });

    let yq = new MockEventQueue;
    let editor = new MockAceEditor(yq);
    let y = new RGA.AceEditorRGA(1, editor, x.history(), q);
    assert.strictEqual(editor.getValue(), "HOME RUN");
    RGA.tie(x, y);

    // A character is deleted, using the editor. Note that we'll be out of
    // sync until the edit event is delivered from e to p.
    editor.remove({start: {row: 0, column: 4}, end: {row: 0, column: 5}});
    assert.strictEqual(editor.getValue(), "HOMERUN");
    assert.strictEqual(y.text(), "HOME RUN");

    // Racing with that change, an edit comes in to the RGA.  This forces the
    // editor state to be reconciled (via diffing), even though we still
    // haven't delivered the edit event yet.
    x.addRight(space, "*");
    q.drain();  // deliver x's event but not editor's
    assert.strictEqual(editor.getValue(), "HOME*RUN");
    assert.strictEqual(y.text(), "HOME*RUN");
    assert.strictEqual(x.text(), "HOME*RUN");

    // Delivering the edit event then has no effect, since we already handled
    // that edit.
    yq.drain();
    assert.strictEqual(editor.getValue(), "HOME*RUN");
    assert.strictEqual(x.text(), "HOME*RUN");
    assert.strictEqual(y.text(), "HOME*RUN");
  });

  it("copes when both editors have new input at the same time", () => {
    let q = new MockEventQueue;
    let e0q = new MockEventQueue;
    let e0 = new MockAceEditor(e0q);
    let a0 = new RGA.AceEditorRGA(0, e0, undefined, q);
    let e1 = new MockAceEditor(q);
    let a1 = new RGA.AceEditorRGA(1, e1, undefined, q);
    RGA.tie(a0, a1);
    e1.setValue("\n");
    e0.setValue("\n");
    e0q.drain();
    q.drain();
    e0q.drain();
    assert.strictEqual(e0.getValue(), "\n\n");
    assert.strictEqual(e1.getValue(), "\n\n");
  });

  it("orders characters the same when text is inserted simultaneously in different replicas", () => {
    let q = new MockEventQueue;
    let e0 = new MockAceEditor(q);
    let a0 = new RGA.AceEditorRGA(0, e0, undefined, q);
    let e1 = new MockAceEditor(q);
    let a1 = new RGA.AceEditorRGA(1, e1, undefined, q);
    RGA.tie(a0, a1);
    e0.setValue("X");
    e1.setValue("Y");
    q.drain();
    assert.strictEqual(e0.getValue(), "YX");
    assert.strictEqual(e1.getValue(), "YX");
  });

  it("copes when the same text is deleted simultaneously in different replicas", () => {
    let q = new MockEventQueue;
    let a1 = new RGA.AceEditorRGA(1, new MockAceEditor(q), undefined, q);
    let a2 = new RGA.AceEditorRGA(2, new MockAceEditor(q), undefined, q);
    RGA.tie(a1, a2);
    a1.editor.setValue("atta");
    q.drain();
    a2.editor.setValue("ta");
    a1.editor.setValue("ta");
    q.drain();
  });
});
