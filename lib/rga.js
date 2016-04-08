// -*- mode: javascript; js-indent-level: 2 -*-
//
// rga.js - An implementation of the Replicated Growable Array (RGA) given in
// "A comprehensive study of Convergent and Commutative Replicated Data Types"
// by Marc Shapiro, Nuno Preguiça, Carlos Baquero, Marek Zawirski, page 34.

"use strict";

var MAX_REPLICA_ID_BITS = 16;

function RGA(id, history) {
  if (typeof id !== "number" || (id | 0) !== id || id < 0 || id >= (1 << MAX_REPLICA_ID_BITS))
    throw new TypeError("RGA constructor: first argument is not a valid id");
  this.id = id;
  this.left = {next: undefined, timestamp: -1, atom: undefined, removed: false};
  this._index = new Map([[this.left.timestamp, this.left]]);
  this._nextTimestamp = id;
  this._subscribers = [];

  var self = this;
  this.downstream = function (sender, op) {
    self._downstream(sender, op);
  };

  if (history !== undefined) {
    for (var i = 0; i < history.length; i++)
      this._downstream(this.downstream, history[i]);
  }
}

RGA.prototype = {
  constructor: RGA,

  _timestamp: function () {
    var t = this._nextTimestamp;
    this._nextTimestamp += (1 << MAX_REPLICA_ID_BITS);
    return t;
  },

  // Apply an operation and broadcast it to other replicas.
  _downstream: function (sender, op) {
    var self = this.downstream;
    this["_downstream_" + op.type].call(this, op);
    this._subscribers.forEach(function (callback) {
      if (callback !== sender)
        callback(self, op);
    });
  },

  // Add an event listener. An RGA only emits one kind of event: "op".
  on: function (type, callback) {
    if (type === "op")
      this._subscribers.push(callback);
  },

  // Remove an event listener.
  off: function (type, callback) {
    if (type === "op") {
      var i = this._subscribers.indexOf(callback);
      if (i !== -1)
        this._subscribers.splice(i, 1);
    }
  },

  // Return an array of ops that builds the entire document.
  history: function () {
    var h = [];
    var prev = this.left;
    var curr = prev.next;
    while (curr !== undefined) {
      h.push({
        type: "addRight",
        t: prev.timestamp,
        w: {timestamp: curr.timestamp, atom: curr.atom}
      });
      if (curr.removed)
        h.push({type: "remove", t: curr.timestamp});
      prev = curr;
      curr = curr.next;
    }
    return h;
  },

  addRight: function (t, a) {
    var pred = this._index.get(t);
    if (pred === undefined)
      throw new Error("insertion point is not in the array");
    if (pred.removed)
      throw new Error("insertion point is removed from the array");

    var node = {timestamp: this._timestamp(), atom: a};
    this._downstream(this.downstream, {type: "addRight", t: t, w: node});
    return node.timestamp;
  },

  _downstream_addRight: function (op) {
    // Any future timestamps we generate must be after timestamps we've
    // observed.
    if (op.w.timestamp >= this._nextTimestamp) {
      var t = (op.w.timestamp >>> MAX_REPLICA_ID_BITS) + 1;
      this._nextTimestamp = (t << MAX_REPLICA_ID_BITS) + this.id;
    }

    var w = op.w;
    var pred = this._index.get(op.t);
    if (pred === undefined)
      throw new Error("downstream: can't add next to unknown element!");
    while (pred.next && w.timestamp < pred.next.timestamp)
      pred = pred.next;

    // Splice a new node into the linked list.
    var node = {
      next: pred.next,
      timestamp: w.timestamp,
      atom: w.atom,
      removed: false
    };
    pred.next = node;
    this._index.set(w.timestamp, node);
  },

  _lookup: function (t) {
    var node = this._index.get(t);
    return node !== undefined && !node.removed;
  },

  remove: function (t) {
    if (!this._lookup(t))
      throw new Error("can't remove node that doesn't exist");
    this._downstream(this.downstream, {type: "remove", t: t});
  },

  _downstream_remove: function (op) {
    var node = this._index.get(op.t);
    if (node === undefined)
      throw new Error("downstream: can't remove unknown element!");
    if (node.removed)
      throw new Error("downstream: element already removed");
    node.removed = true;
  },

  text: function () {
    var s = "";
    for (var node = this.left.next; node; node = node.next) {
      if (!node.removed)
        s += node.atom;
    }
    return s;
  },

  // Get the node immediately to the left of the given cursor location.
  // If line == 0 and column == 0, this returns this.left.
  getNodeAt: function (line, column) {
    var l = 0, c = 0;
    var node = this.left;
    while (node && (l < line || (l === line && c < column))) {
      node = node.next;
      if (!node.removed) {
        if (node.atom ==="\n") {
          l++;
          c = 0;
        } else {
          c++;
        }
      }
    }
    return node;
  },

  getRowColumnBefore: function (t) {
    if (t === this.left.timestamp)
      throw new Error("no position before the left edge of the document");
    var target = this._index.get(t);
    if (target === undefined)
      throw new Error("timestamp not present in document");
    var r = 0, c = 0;
    for (var node = this.left.next; node != target; node = node.next) {
      if (!node.removed) {
        if (node.atom === "\n") {
          r++;
          c = 0;
        } else {
          c++;
        }
      }
    }
    return {row: r, column: c};
  },

  getRowColumnAfter: function (t) {
    var target = this._index.get(t);
    if (target === undefined)
      throw new Error("timestamp not present in document");
    var r = 0, c = -1;  // c will be incremented to zero in the first pass through the loop
    for (var node = this.left; ; node = node.next) {
      if (!node.removed) {
        if (node.atom === "\n") {
          r++;
          c = 0;
        } else {
          c++;
        }
      }
      if (node === target)
        break;
    }
    return {row: r, column: c};
  },

  insertRowColumn: function (source, line, column, text) {
    var r = 1;
    var u = this.getNodeAt(line, column).timestamp;
    for (var i = 0; i < text.length; i++) {
      var node = {atom: text[i], timestamp: this._timestamp()};
      this._downstream(source, {type: "addRight", t: u, w: node});
      u = node.timestamp;
    }
  },

  removeRowColumn: function (source, line, column, length) {
    var node = this.getNodeAt(line, column);
    for (var i = 0; i < length; i++) {
      node = node.next;
      while (node && node.removed)
        node = node.next;
      if (!node)
        throw new Error("tried to remove more characters than exist in document");
      this._downstream(source, {type: "remove", t: node.timestamp});
    }
  },

  // Convenience method to apply a patch. The structure of `delta` is the same
  // as a Quill delta, just because it was a JSON patch format I knew about --
  // RGA doesn't actually use any Quill code.
  applyDelta: function (delta) {
    var source = this.downstream;
    var lastNode = this.left, node = lastNode.next;
    var ops = delta.ops;
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      //console.log("* applying", op);
      if ("retain" in op) {
        for (var j = 0; j < op.retain;) {
          if (!node.removed) {
            lastNode = node;
            j++;
          }
          node = node.next;
        }
      } else if ("delete" in op) {
        for (var j = 0; j < op.delete;) {
          var next = node.next;
          if (!node.removed) {
            lastNode = node;
            j++;
            //console.log("  - removing character:", node.atom);
            this._downstream(source, {type: "remove", t: node.timestamp});
          }
          node = next;
        }
      } else if ("insert" in op) {
        var t = lastNode.timestamp;
        var str = op.insert;
        for (var j = 0; j < str.length; j++) {
          //console.log("  - inserting character:", str[j]);
          var tnext = this._timestamp();
          var next = {atom: str[j], timestamp: tnext};
          this._downstream(source, {type: "addRight", t: t, w: next});
          t = tnext;
        }
        lastNode = this._index.get(t);
        node = lastNode.next;
      }
    }
  },

  timestampToIndex: function (t) {
    var offset = -1;
    for (var node = this.left; node.timestamp !== t; node = node.next) {
      if (!node.removed)
        offset++;
    }
    return offset;
  }
};

// Cause two RGA objects to update each other.
// They must initially contain the same history.
RGA.tie = function tie(a, b) {
  if (JSON.stringify(a.history()) != JSON.stringify(b.history()))
    throw new Error("RGA.tie: arguments must start out already in sync");

  a.on("op", b.downstream);
  b.on("op", a.downstream);
};

// Cause an RGA object to communicate via socket.io to update an RGA object
// tied to the other end of the socket. The two RGA objects must initially
// contain the same history.
RGA.tieToSocket = function tieToSocket(a, s) {
  var a_s = function (sender, op) {
    s.emit("downstream", op);
  };
  a.on("op", a_s);
  s.on("downstream", function (op) {
    a.downstream(a_s, op);
  });

  // Cleanup.
  s.on("disconnect", function () {
    a.off("op", a_s);
  });
};

// Return a Quill patch to turn the string s0 into s1.
// (Helper function used by RGA.tieToAceEditor().)
RGA.diff = function diff(s0, s1) {
  //console.log("diffing", {a: s0, b: s1});

  // Hand-rolled implementation of the Hunt–McIlroy diffing algorithm.
  // I used <http://pynash.org/2013/02/26/diff-in-50-lines/> as a reference.
  function find_longest_common_slice(a, b) {
    var map_of_b = Object.create(null);
    for (var i = 0; i < b.length; i++) {
      let ch = b[i];
      let list = map_of_b[ch];
      if (list)
        list.push(i);
      else
        map_of_b[ch] = [i];
    }

    var result = {
      a_start: 0,
      b_start: 0,
      length: 0
    };

    var runs = Object.create(null);
    for (var i = 0; i < a.length; i++) {
      var new_runs = Object.create(null);
      var matches_in_b = map_of_b[a.charAt(i)];
      if (matches_in_b) {
        for (var match_index = 0; match_index < matches_in_b.length; match_index++) {
          var j = matches_in_b[match_index];
          var k = new_runs[j] = (runs[j - 1] || 0) + 1;
          if (k > result.length) {
            result.a_start = i - k + 1;
            result.b_start = j - k + 1;
            result.length = k;
          }
        }
      }
      runs = new_runs;
    }

    if (a.slice(result.a_start, result.a_start + result.length) !==
        b.slice(result.b_start, result.b_start + result.length)) {
      throw new Error("algorithm failed");
    }
    return result;
  }

  function compare(a, b, start, patch) {
    if (a !== b) {
      let match = find_longest_common_slice(a, b);
      if (match.length === 0) {
        if (a)
          patch.push({delete: a.length});
        if (b)
          patch.push({insert: b});
      } else {
        compare(a.slice(0, match.a_start), b.slice(0, match.b_start), start, patch);
        patch.push({retain: match.length});
        compare(a.slice(match.a_start + match.length),
                b.slice(match.b_start + match.length),
                start + match.a_start + match.length,
                patch);
      }
    }
  }

  var patch = [];
  compare(s0, s1, 0, patch);
  //console.log("diff result:", patch);
  return {ops: patch};
};

// Cause an RGA object and an instance of the Ace editor update each other.
//
// This function uses the following features of the Ace API:
// - editor.getValue() -> string
// - editor.setValue(str, -1)
// - editor.getSession().on("change", f)
// - editor.getSession().off("change", f)
// - editor.getSession().insert({row: r, column: c}, str)
// - editor.getSession().remove({start: ..., end: ...})
// - editor.getSession().getDocument().getLine(loc.row) -> string
//
RGA.tieToAceEditor = function tieToAceEditor(rga, editor) {
  var editorReplica = new RGA(rga.id, rga.history());  // ok to reuse id?

  // `lastText` is the text that was in the editor, last we checked.  When a
  // keypress happens and the text in the editor changes, Ace will notify us of
  // the change, but not immediately: instead, it queues an event to fire
  // asynchronously. In fact, at any given point in time we have no way of
  // knowing whether we've been notified of all changes or something's still in
  // flight. The solution is brute force (see takeUserEdits) and requires us to
  // remember the last known in-sync state of the document, hence this
  // variable.
  var lastText = rga.text();

  function assertInSync(infodump) {
    let erText = editorReplica.text();
    if (lastText != erText) {
      infodump.lastText = lastText;
      infodump.editorReplicaText = erText;
      console.error(rga.id, "lastText and editorReplica are out of sync", infodump);
      throw new Error("editor and RGA data structure got out of sync");
    }
  }

  // The editor must start out in sync with the RGA.
  // (The `-1` here means to place the editor cursor at the start of the document.)
  editor.setValue(lastText, -1);

  // The flow of operations is (unavoidably) bidirectional.
  // First, propagate user edits from Ace to the editorReplica.
  function takeUserEdits() {
    var currentText = editor.getValue();
    if (currentText != lastText) {
      assertInSync({currentEditorState: currentText});

      var changes = RGA.diff(lastText, currentText);
      editorReplica.applyDelta(changes);
      var savedLastText = lastText;
      lastText = currentText;

      assertInSync({before: savedLastText, patch: changes});
    }
  }
  var editorSession = editor.getSession();
  editorSession.on("change", takeUserEdits);
  function withEditorCallbacksDisabled(action) {
    editorSession.off("change", takeUserEdits);
    action();
    editorSession.on("change", takeUserEdits);
  }

  // Now for the other direction: deliver ops from the RGA to the editor.

  // Apply an RGA op to the Ace editor.
  function applyOpToEditor(op) {
    switch (op.type) {
    case "addRight":
      var loc = rga.getRowColumnAfter(op.t);
      //console.log("inserting character", op.w.atom, "at", loc);
      withEditorCallbacksDisabled(() => {
        editorSession.insert(loc, op.w.atom);
      });
      break;

    case "remove":
      //console.log("remove:", op.t, " from:", rga);
      var loc = rga.getRowColumnBefore(op.t);
      var removingNewline = editorSession.getDocument().getLine(loc.row).length === loc.column;
      var whatToRemove = {
        start: loc,
        end: removingNewline
          ? {row: loc.row + 1, column: 0}
          : {row: loc.row, column: loc.column + 1}
      };
      //console.log("removing from editor:", whatToRemove);
      withEditorCallbacksDisabled(() => {
        editorSession.remove(whatToRemove);
      });
      break;
    }
  }

  editorReplica._base_downstream = editorReplica.downstream;
  editorReplica.downstream = function rgaToEditor(source, op) {
    // Always check for new user edits *before* accepting ops from the internet.
    // That way, takeUserEdits() knows that all differences between
    // `lastText` and `editor.getValue()` are the result of new user input.
    takeUserEdits();

    //console.log("editorReplica.downstream: received op (from socket):", op);

    // Since applyOpToEditor uses editorReplica to look up the location of the
    // inserted/deleted character in the document, we have to call that first,
    // before modifying editorReplica.
    applyOpToEditor(op);  // first update the editor
    editorReplica._base_downstream(source, op);  // then update the RGA
    lastText = editor.getValue();
    assertInSync({op: op});
  }
  RGA.tie(rga, editorReplica);
};

if (typeof module !== "undefined")
  exports = module.exports = RGA;
