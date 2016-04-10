// -*- mode: javascript; js-indent-level: 2 -*-
//
// rga.js - An implementation of the Replicated Growable Array (RGA) given in
// "A comprehensive study of Convergent and Commutative Replicated Data Types"
// by Marc Shapiro, Nuno Preguiça, Carlos Baquero, Marek Zawirski, page 34.

"use strict";

var MAX_REPLICA_ID_BITS = 16;

function RGA(id, history, queue) {
  if (typeof id !== "number" || (id | 0) !== id || id < 0 || id >= (1 << MAX_REPLICA_ID_BITS))
    throw new TypeError("RGA constructor: first argument is not a valid id");
  this.id = id;
  this.left = {next: undefined, timestamp: -1, atom: undefined, removed: false};
  this._index = new Map([[this.left.timestamp, this.left]]);
  this._nextTimestamp = id;
  this._subscribers = [];
  this._queue = queue || RGA._browserQueue;

  var self = this;
  this.downstream = function (sender, op) {
    self._downstream(sender, op);
  };
  this.downstream._id = id;

  if (history !== undefined) {
    for (var i = 0; i < history.length; i++)
      this._downstream(this.downstream, history[i]);
  }
}

RGA._logging = false;

RGA._browserQueue = {
  defer: function (cb) { setTimeout(cb, 0); }
};

RGA.prototype = {
  constructor: RGA,

  _timestamp: function () {
    var t = this._nextTimestamp;
    this._nextTimestamp += (1 << MAX_REPLICA_ID_BITS);
    return t;
  },

  // Apply an operation and broadcast it to other replicas.
  _downstream: function (sender, op) {
    //this._log("replica " + this.id + " received " + JSON.stringify(op) + " from " + sender._id);
    var self = this.downstream;
    this["_downstream_" + op.type].call(this, op);
    var queue = this._queue;
    this._subscribers.forEach(function (callback) {
      if (callback !== sender)
        queue.defer(function () { callback(self, op); });
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
    this.downstream(this.downstream, {type: "addRight", t: t, w: node});
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
    this.downstream(this.downstream, {type: "remove", t: t});
  },

  _downstream_remove: function (op) {
    var node = this._index.get(op.t);
    if (node === undefined)
      throw new Error("downstream: can't remove unknown element!");
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

  timestampToIndex: function (t) {
    var offset = -1;
    for (var node = this.left; node.timestamp !== t; node = node.next) {
      if (!node.removed)
        offset++;
    }
    return offset;
  },

  _log: function () {
    if (RGA._logging)
      console.log.apply(console, arguments);
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

// Return a delta to turn the string s0 into s1.
// (Helper function used by RGA.AceEditorRGA#_takeUserEdits.)
RGA.diff = function diff(s0, s1) {
  //console.log("diffing", {a: s0, b: s1});

  // Hand-rolled implementation of the Hunt–McIlroy diffing algorithm.
  // I used <http://pynash.org/2013/02/26/diff-in-50-lines/> as a reference.
  function find_longest_common_slice(a, b) {
    var map_of_b = Object.create(null);
    for (var i = 0; i < b.length; i++) {
      var ch = b[i];
      var list = map_of_b[ch];
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
      var match = find_longest_common_slice(a, b);
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

// An RGA that has an instance of the Ace editor attached to it.
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
RGA.AceEditorRGA = function AceEditorRGA(id, editor, history, queue) {
  RGA.call(this, id, history, queue);
  this.editor = editor;

  // `_lastText` is the text that was in the editor, last we checked.  When a
  // keypress happens and the text in the editor changes, Ace will notify us of
  // the change, but not immediately: instead, it queues an event to fire
  // asynchronously. In fact, at any given point in time we have no way of
  // knowing whether we've been notified of all changes or something's still in
  // flight. The solution is brute force (see takeUserEdits) and requires us to
  // remember the last known in-sync state of the document, hence this
  // variable.
  this._lastText = this.text();

  // The editor must start out in sync with the RGA.
  // (The `-1` here means to place the editor cursor at the start of the document.)
  editor.setValue(this._lastText, -1);

  // The flow of operations is (unavoidably) bidirectional. First, when Ace
  // notifies us of an edit, fold those changes into the RGA.
  var self = this;
  this._changeCallback = function () { self._takeUserEdits() };
  editor.getSession().on("change", this._changeCallback);

  // Now for the other direction. Replace the callback that receives changes
  // from other RGAs with a new one that also updates the editor.
  this.downstream = function (source, op) {
    self._customDownstream(source, op);
  };
  this.downstream._id = id;
};

RGA.AceEditorRGA.prototype = Object.create(RGA.prototype);
Object.assign(RGA.AceEditorRGA.prototype, {
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

  getRowColumnAfter: function (t, wt) {
    var target = this._index.get(t);
    if (target === undefined)
      throw new Error("timestamp not present in document");

    var r = 0, c = -1;  // c will be incremented to zero in the first pass through the loop
    function advance(node) {
      if (!node.removed) {
        if (node.atom === "\n") {
          r++;
          c = 0;
        } else {
          c++;
        }
      }
    }

    for (var node = this.left; ; node = node.next) {
      advance(node);
      if (node === target)
        break;
    }
    while (node.next && wt < node.next.timestamp) {
      node = node.next;
      advance(node);
    }

    return {row: r, column: c};
  },

  _assertInSync: function () {
    var erText = this.text();
    if (this._lastText != erText) {
      infodump.lastText = this._lastText;
      infodump.rgaText = erText;
      console.error(this.id, "lastText and rga are out of sync", infodump);
      throw new Error("editor and RGA data structure got out of sync");
    }
  },

  // Convenience method to apply a patch. The structure of `delta` is the same
  // as a Quill delta, just because it was a JSON patch format I knew about --
  // RGA doesn't actually use any Quill code.
  _applyDelta: function (delta) {
    var source = this.downstream;
    var lastNode = this.left, node = lastNode.next;
    var ops = delta.ops;
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      //this._log("* applying", op);
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
            //this._log("  - removing character:", node.atom);
            this._downstream(source, {type: "remove", t: node.timestamp});
          }
          node = next;
        }
      } else if ("insert" in op) {
        var t = lastNode.timestamp;
        var str = op.insert;
        for (var j = 0; j < str.length; j++) {
          //this._log("  - inserting character:", str[j]);
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

  _takeUserEdits: function () {
    var currentText = this.editor.getValue();
    //this._log("_takeUserEdits: <" + currentText + "> <" + this._lastText + ">");
    if (currentText != this._lastText) {
      this._assertInSync({currentEditorState: currentText});

      var changes = RGA.diff(this._lastText, currentText);
      //this._log(changes);
      this._applyDelta(changes);
      var savedLastText = this._lastText;
      this._lastText = currentText;

      this._assertInSync({before: savedLastText, patch: changes});
    }
  },

  _withEditorCallbacksDisabled: function(action) {
    this.editor.getSession().off("change", this._changeCallback);
    action();
    this.editor.getSession().on("change", this._changeCallback);
  },

  // Apply an RGA op to the Ace editor.
  _applyOpToEditor: function (op) {
    var editor = this.editor;
    var session = editor.getSession();
    switch (op.type) {
    case "addRight":
      if (this._index.has(op.w.timestamp)) {
        // This character was already added.
        throw new Error("bug - message delivered twice to " + this._id + ": ", JSON.stringify(op));
      }

      var loc = this.getRowColumnAfter(op.t, op.w.timestamp);
      //this._log("inserting character", op.w.atom, "at", loc);
      this._withEditorCallbacksDisabled(function () {
        session.insert(loc, op.w.atom);
      });
      break;

    case "remove":
      //this._log("remove:", op.t, " from:", this);
      if (this._index.get(op.t).removed) {
        // This character has already been removed. Nothing to do.
        break;
      }

      var loc = this.getRowColumnBefore(op.t);
      var removingNewline = session.getDocument().getLine(loc.row).length === loc.column;
      var whatToRemove = {
        start: loc,
        end: removingNewline
          ? {row: loc.row + 1, column: 0}
          : {row: loc.row, column: loc.column + 1}
      };
      //this._log("removing from editor:", whatToRemove);
      this._withEditorCallbacksDisabled(function () {
        session.remove(whatToRemove);
      });
      break;
    }
  },

  _customDownstream: function (source, op) {
    // Always check for new user edits *before* accepting ops from the internet.
    // That way, _takeUserEdits() knows that all differences between
    // `_lastText` and `editor.getValue()` are the result of new user input.
    this._takeUserEdits();

    // Since applyOpToEditor uses the RGA to look up the location of the
    // inserted/deleted character in the document, and determine whether it has in fact
    // already been inserted/deleted, we have to call that first,
    // before modifying the RGA.
    this._applyOpToEditor(op);  // first update the editor
    this._downstream(source, op);  // then update the RGA
    this._lastText = this.editor.getValue();

    this._assertInSync({op: op});
  }
});

if (typeof module !== "undefined")
  exports = module.exports = RGA;
