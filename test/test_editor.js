// -*- mode: javascript; js-indent-level: 2 -*-

"use strict";

var RGA = require("../lib/rga.js");
var testsupport = require("../lib/testsupport.js");
var MockSocket = testsupport.MockSocket;
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

  focus() {}
}

describe("RGA.AceEditorRGA", () => {
  it("propagates inserts from the RGA to the editor", () => {
    let q = new MockEventQueue;
    let e = new RGA.AceEditorRGA(0, new MockAceEditor(q));
    var cursor = e.left.timestamp;
    cursor = e.addRight(cursor, "h");
    cursor = e.addRight(cursor, "i");
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
    let x = new RGA.AceEditorRGA(0, new MockAceEditor(q), undefined, q);
    var c = x.addRight(x.left.timestamp, "c");
    var b = x.addRight(x.left.timestamp, "b");
    var a = x.addRight(x.left.timestamp, "a");
    assert.strictEqual(x.editor.getValue(), "abc");

    x.remove(b);
    assert.strictEqual(x.editor.getValue(), "ac");
    x.remove(a);
    assert.strictEqual(x.editor.getValue(), "c");
    x.remove(c);
    assert.strictEqual(x.editor.getValue(), "");
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

  it("stays in sync with multiple editors racing randomly", () => {
    function rnd(n) {
      return Math.floor(n * Math.random());
    }

    function testRace(log) {
      let test = {};

      function _do(_code) {
        log.push(_code);
        eval(_code);
      }

      function uneval(s) {
        return '"' + s.replace(/\t/g, '\\t').replace(/\n/g, '\\n') + '"';
      }

      let ops = [
        s => s.slice(0, 1) + 'x' + s.slice(1),
        s => s + 'a',
        s => s + '\n',
        s => s.slice(0, 2) + s.slice(3),  // delete a character
        s => s.charAt(0) + s.slice(s.length - 1),
        s => s.replace(/^/g, "\t")  // indent
      ];

      let nqueues = 1 + rnd(3);
      for (let i = 0; i < nqueues; i++) {
        _do(`test.q${i} = new MockEventQueue;`);
      }

      // Create some editors, connected randomly
      let nreplicas = 2 + rnd(3);
      for (let i = 0; i < nreplicas; i++) {
        _do(`test.e${i} = new MockAceEditor(test.q${rnd(nqueues)});`);
        _do(`test.a${i} = new RGA.AceEditorRGA(${i}, test.e${i}, undefined, test.q${rnd(nqueues)});`);
        if (i > 0) {
          let j = rnd(i);
          _do(`RGA.tie(test.a${j}, test.a${i});`);
        }
      }

      // create random mutations, occasionally randomly flushing a queue
      let flushProbability = 0.9 * Math.random();
      for (let t = 0; t < rnd(100); t++) {
        if (Math.random() < flushProbability) {
          _do(`test.q${rnd(nqueues)}.drain();`);
        } else {
          // Random edit.
          let op = ops[rnd(ops.length)];
          let i = rnd(nreplicas);
          let before = test['e' + i].getValue();
          let after = op(before);
          _do(`test.e${i}.setValue(${uneval(after)});`);
        }
      }

      // Flush all queues; repeat until all queues are empty.
      let deliveredAny;
      do {
        deliveredAny = false;
        for (let i = 0; i < nqueues; i++) {
          if (test["q" + i]._queue.length > 0) {
            deliveredAny = true;
            _do(`test.q${i}.drain();`);
          }
        }
      } while (deliveredAny);

      let expected = test.e0.getValue();
      for (let i = 0; i < nreplicas; i++) {
        assert.strictEqual(test["a" + i].text(), expected);
        assert.strictEqual(test["e" + i].getValue(), expected);
      }
    }

    let ntrials = 100;
    for (let i = 0; i < ntrials; i++) {
      let log = [];
      try {
        testRace(log);
      } catch (exc) {
        console.log("// FAILED TEST FOLLOWS ===========================================");
        for (let j = 0; j < log.length; j++)
          console.log(log[j]);
        throw exc;
      }
    }
  });

  it("works over sockets", () => {
    let q = new MockEventQueue;
    let root = new RGA(0, undefined, q);

    let pipeA = MockSocket.pair(q);
    RGA.tieToSocket(root, pipeA[0]);
    let editorA = new MockAceEditor(q);
    RGA.AceEditorRGA.setup(editorA, pipeA[1], q);
    pipeA[0].emit("welcome", {id: 1, history: []});

    let pipeB = MockSocket.pair(q);
    RGA.tieToSocket(root, pipeB[0]);
    let editorB = new MockAceEditor(q);
    RGA.AceEditorRGA.setup(editorB, pipeB[1], q);
    pipeB[0].emit("welcome", {id: 2, history: []});

    q.drain();
    editorA.setValue("ya");
    editorB.setValue("hi");
    q.drain();

    assert.strictEqual(editorA.getValue(), "hiya");
    assert.strictEqual(editorB.getValue(), "hiya");
  });
});
